// Large-dataset engine: profiles a CSV file and runs a pipeline over it in chunks, using the same js/etl.js the
// console uses (loaded into this process), so a step gives the same result here as in the browser preview.
'use strict';
const fs = require('fs');
const path = require('path');
const v8 = require('v8');
const { readCSV, headText, isGz } = require('./csvstream');
const { readJSONL, isJSONL, scanColumns, splitRanges } = require('./jsonlstream');
const { Worker } = require('worker_threads');
const os = require('os');
const { readParquet, isParquet, ParquetWriter, parquetInfo } = require('./parquet');

const QETL = require('./qetl');

const BATCH = 50000;
const SAMPLE_ROWS = 50000; // rows kept for the console's interactive preview

const formatOf = (file) => (isParquet(file) ? 'parquet' : isJSONL(file) ? 'jsonl' : 'csv');
async function delimiterFor(file, name) {
  if (formatOf(file) !== 'csv') return null;
  if (/\.tsv(\.gz)?$/i.test(file) || /\.tsv(\.gz)?$/i.test(name || '')) return '\t';
  return QETL.detectDelimiter(await headText(file));
}
/** { columns, rows } batches from a CSV/TSV, JSONL or Parquet file (format from the file's extension). */
function readAny(file, opts = {}) {
  const f = formatOf(file);
  if (f === 'parquet') return readParquet(file, opts);
  if (f === 'jsonl') return readJSONL(file, opts);
  return readCSV(file, opts);
}

class LimitError extends Error {}

/**
 * Profiles a file in two passes. Returns { columns, rows, profile, sample, delimiter }.
 * opts: name, limitRows, onProgress({ phase, rows, bytes, totalBytes }).
 */
async function profileFile(file, opts = {}) {
  const delimiter = opts.delimiter || await delimiterFor(file, opts.name);
  const totalBytes = fs.statSync(file).size;
  const tick = (phase, rows, bytes) => opts.onProgress && opts.onProgress({ phase, rows, bytes, totalBytes });
  let prof = null, columns = null, rows = 0, bytes = 0;
  for await (const b of readAny(file, { delimiter, batch: opts.batch || BATCH, onBytes: (x) => { bytes = x; }, onScan: (x) => tick('schema', 0, x) })) {
    if (!prof) { columns = b.columns; prof = QETL.createProfiler(columns); }
    prof.addSample(b.rows); rows += b.rows.length;
    if (opts.limitRows != null && rows > opts.limitRows) throw new LimitError(`The file has more than ${opts.limitRows.toLocaleString('en-US')} rows.`);
    tick('scan', rows, bytes);
  }
  if (!columns || !columns.length) throw new Error('The file is empty.');
  prof.decide();
  let done = 0;
  for await (const b of readAny(file, { delimiter, columns, batch: opts.batch || BATCH, onBytes: (x) => { bytes = x; } })) {
    prof.add(b.rows); done += b.rows.length; tick('profile', done, bytes);
  }
  return { columns, rows, profile: prof.finish(), sample: prof.sampleRows(SAMPLE_ROWS), delimiter };
}

/** Steps that can't run over a file in chunks yet: [{ index, step, label }]. */
function unsupportedSteps(steps) {
  return steps.map((s, index) => ({ s, index })).filter(x => !x.s.disabled && QETL.streamMode(x.s) === null)
    .map(x => ({ index: x.index, op: x.s.op, label: QETL.OPS[x.s.op] ? QETL.OPS[x.s.op].label : x.s.op }));
}

const esc = (v) => { if (v === null || v === undefined) return ''; const s = String(v); return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };

// Intermediate chunks between pipeline segments, as length-prefixed V8 serializations: values keep their exact
// in-memory types (numbers, booleans, strings), so later steps see exactly what they would in the browser.
class ChunkFile {
  constructor(file) { this.file = file; this.out = fs.createWriteStream(file, { highWaterMark: 1 << 22 }); }
  async write(table) {
    const body = v8.serialize(table), head = Buffer.alloc(4); head.writeUInt32LE(body.length);
    const a = this.out.write(head), b = this.out.write(body);
    if (!a || !b) await new Promise(r => this.out.once('drain', r));
  }
  close() { return new Promise((res, rej) => { this.out.on('error', rej); this.out.end(res); }); }
  static async *readAll(files, onBytes) { let base = 0; for (const f of files) { const size = fs.statSync(f).size; yield* ChunkFile.read(f, (x) => onBytes && onBytes(base + x)); base += size; } }
  static async *read(file, onBytes) {
    let parts = [], have = 0, need = -1, bytes = 0; // pieces are joined once per frame, not once per piece
    for await (const piece of fs.createReadStream(file, { highWaterMark: 1 << 22 })) {
      bytes += piece.length; parts.push(piece); have += piece.length;
      for (;;) {
        if (need < 0) { if (have < 4) break; const head = parts.length === 1 ? parts[0] : Buffer.concat(parts); parts = [head]; need = head.readUInt32LE(0) + 4; }
        if (have < need) break;
        const all = parts.length === 1 ? parts[0] : Buffer.concat(parts);
        const t = v8.deserialize(all.subarray(4, need));
        const rest = all.subarray(need); parts = rest.length ? [rest] : []; have = rest.length; need = -1;
        if (onBytes) onBytes(bytes);
        yield t;
      }
    }
  }
}

// What a step can change, for deciding which fitted steps can share a pass (see runFile).
// rows: may remove or reorder rows. all: may rename, drop or rewrite any column. writes: column names it rewrites.
// adds: appends new columns (harmless unless a later step reads one of them, which the header check catches).
function effectOf(s) {
  const p = s.params || {}, cols = [].concat(p.columns || []).filter(Boolean);
  const listed = (extra = []) => (cols.length ? { writes: new Set([...cols, ...extra]) } : { all: true });
  switch (s.op) {
    case 'standardize_nulls': case 'trim': case 'case': case 'clean_numeric': case 'parse_dates': case 'cast': case 'replace':
    case 'round': case 'scale': case 'standardize_categories': case 'fill_null': case 'mask': return listed();
    case 'range_check': return p.action === 'remove' ? { rows: true } : p.action === 'flag' ? { adds: true } : { writes: new Set([p.column]) };
    case 'outliers': return (p.action || 'remove') === 'remove' ? { rows: true } : p.action === 'flag' ? { adds: true } : { writes: new Set([p.column]) };
    case 'filter': case 'drop_null_rows': case 'drop_duplicates': case 'sort': case 'near_duplicates': case 'length_filter': return { rows: true };
    case 'text_quality': return (p.action || 'remove') === 'flag' ? { adds: true } : { rows: true };
    case 'language': return String(p.keep || '').trim() ? { rows: true, adds: true } : { adds: true };
    case 'redact_text': return listed();
    case 'token_count': case 'train_test_split': case 'format_chat': return { adds: true };
    case 'split': case 'derive': case 'one_hot': return { adds: true };
    default: return { all: true }; // rename, snake_case_headers, drop_columns, anything new
  }
}
function readsOf(s) { // columns a fitted step's fit looks at, or null for "all columns"
  const p = s.params || {};
  if (s.op === 'outliers' || s.op === 'one_hot') return [p.column];
  const cols = [].concat(p.columns || []).filter(Boolean); if (!cols.length) return null;
  return s.op === 'fill_null' && p.groupBy ? [...cols, p.groupBy] : cols;
}

/**
 * Runs the enabled steps over the file and writes the result as CSV (same format as QETL.toCSV), then profiles the
 * output. Returns { columns, rows, rowsIn, results, profile, sample, ms }.
 * The pipeline is cut into segments at each fitted step (medians, category maps, bounds need the whole column):
 * a pass runs one segment, fits the next step on its output and saves that output for the next pass, so every step
 * runs exactly once.
 */
async function runFile(file, steps, outFile, opts = {}) {
  const t0 = Date.now();
  const delimiter = opts.delimiter || await delimiterFor(file, opts.name);
  const all = steps.map((s, i) => ({ s, i })).filter(x => !x.s.disabled);
  const bad = unsupportedSteps(steps);
  if (bad.length) throw new Error(`${bad.map(b => `Step ${b.index + 1} (${b.label})`).join(', ')} can't run on large datasets yet. Disable or remove it, then run again.`);
  const modes = all.map(x => QETL.streamMode(x.s)), effects = all.map(x => effectOf(x.s));
  const fitIdx = modes.map((m, k) => (m === 'fit' ? k : -1)).filter(k => k >= 0);
  const fitted = [], fitDone = [], skip = [], states = [], stats = [];
  let passes = fitIdx.length + 2, pass = 0;
  const tmpDir = opts.tmpDir || path.dirname(outFile), tag = path.basename(outFile);
  const temps = [];

  const applySteps = (table, from, to, firstChunk) => {
    let t = table;
    for (let k = from; k < to; k++) {
      if (skip[k]) continue;
      const { s } = all[k], op = QETL.OPS[s.op], p = s.params || {}, mode = modes[k];
      const before = t.rows.length; let r; stepNow = k;
      try { r = mode === 'state' ? op.applyChunk(t, p, states[k] || (states[k] = {})) : mode === 'fit' ? op.applyFit(t, p, fitted[k]) : op.apply(t, p); }
      catch (e) {
        if (firstChunk) { skip[k] = e.message; continue; } // as in the preview: a step that fails is skipped
        throw new Error(`Step ${all[k].i + 1} (${op.label}) failed: ${e.message}`);
      }
      stepNow = -1; t = r.table;
      const st = stats[k] || (stats[k] = { affected: 0, rowsBefore: 0, rowsAfter: 0 });
      st.affected = op.affectedOnce ? r.affected : st.affected + r.affected; st.rowsBefore += before; st.rowsAfter += t.rows.length;
    }
    return t;
  };
  // Fitted steps after `f` whose fit can be computed on the same table as f's (nothing from f up to them can change
  // the rows or the columns they read), so they share f's pass.
  const mergeable = (f, columns) => {
    const out = [f];
    for (const g of fitIdx) {
      if (g <= f) continue;
      const reads = readsOf(all[g].s); if (!reads || !reads.every(c => columns.includes(c))) break;
      let ok = true;
      for (let k = f; k < g && ok; k++) { if (skip[k]) continue; const e = effects[k]; if (e.rows || e.all || (e.writes && reads.some(c => e.writes.has(c)))) ok = false; }
      if (!ok) break;
      out.push(g);
    }
    return out;
  };
  const cur = { bytes: 0, total: 0 };
  const tick = (phase, rows) => opts.onProgress && opts.onProgress({ phase, pass, passes, rows, bytes: cur.bytes, totalBytes: cur.total });

  // Removal ledger: one CSV line per removed row (step, reason, first column, an excerpt of its longest text), and
  // reason counts per step for the job record.
  let stepNow = -1, ledgerBuf = '', ledgerOut = null; const reasonCounts = [];
  if (opts.ledgerFile) {
    ledgerOut = fs.createWriteStream(opts.ledgerFile + '.part', { highWaterMark: 1 << 20 });
    ledgerOut.write('step,step_name,reason,detail,first_column,excerpt\n');
  }
  const excerpt = (row) => { let best = ''; for (const v of row) if (typeof v === 'string' && v.length > best.length) best = v; return best.replace(/\s+/g, ' ').slice(0, 120); };
  QETL.setReasonSink((row, why, detail) => {
    const k = stepNow; if (k < 0) return;
    const m = reasonCounts[k] || (reasonCounts[k] = new Map());
    if (m.has(why) || m.size < 50) m.set(why, (m.get(why) || 0) + 1); else m.set('Other reasons', (m.get('Other reasons') || 0) + 1);
    if (ledgerOut) ledgerBuf += [all[k].i + 1, QETL.OPS[all[k].s.op].label, why, detail || '', row[0] === undefined ? '' : row[0], excerpt(row)].map(esc).join(',') + '\n';
  });
  const flushLedger = async () => { if (ledgerOut && ledgerBuf) { const b = ledgerBuf; ledgerBuf = ''; if (!ledgerOut.write(b)) await new Promise(r => ledgerOut.once('drain', r)); } };

  let columns = null, prof = null, rowsIn = 0, rowsOut = 0, profTemp = null, input = null, from = 0;
  const sizeOf = (x) => [].concat(x).reduce((a, f) => a + fs.statSync(f).size, 0);
  QETL.setInPlace(true);
  try {
    // The leading row-by-row steps run on several cores at once, each on its own slice of the file.
    const par = await parallelPrefix(file, all, modes, opts, { tmpDir, tag, tick: (rows, bytes, total) => { cur.bytes = bytes; cur.total = total; pass = 1; tick('run', rows); }, ledgerOut, reasonCounts, stats, esc });
    if (par) { input = par.parts; from = par.prefix; rowsIn = par.rowsIn; temps.push(...par.parts); pass = 1; passes += 1; }
    for (;;) {
      pass++;
      const f = fitIdx.find(k => !fitDone[k] && k >= from), last = f === undefined, to = last ? all.length : f;
      cur.total = input ? sizeOf(input) : fs.statSync(file).size; cur.bytes = 0;
      const src = input ? ChunkFile.readAll([].concat(input), (x) => { cur.bytes = x; })
        : (async function* () { for await (const b of readAny(file, { delimiter, columns: opts.columns, batch: opts.batch || BATCH, onBytes: (x) => { cur.bytes = x; } })) yield { columns: b.columns, rows: b.rows }; })();
      let group = null, fitStates = null, first = true, rows = 0, next, csv = null, write = null;
      if (!last) { const fname = path.join(tmpDir, `${tag}.seg${pass}.tmp`); temps.push(fname); next = new ChunkFile(fname); }
      else {
        csv = fs.createWriteStream(outFile + '.part', { highWaterMark: 1 << 22 });
        write = (x) => (csv.write(x) ? null : new Promise(r => csv.once('drain', r)));
        profTemp = path.join(tmpDir, `${tag}.out.tmp`); next = new ChunkFile(profTemp);
      }
      for await (const chunk of src) {
        const t = applySteps(chunk, from, to, first);
        if (!input) rowsIn += chunk.rows.length;
        if (!last) {
          if (first) { group = mergeable(f, t.columns); fitStates = []; }
          for (let gi = 0; gi < group.length; gi++) {
            const g = group[gi]; if (skip[g]) continue; const op = QETL.OPS[all[g].s.op], p = all[g].s.params || {};
            try { if (!fitStates[gi]) fitStates[gi] = op.fitInit(t, p); op.fitAdd(fitStates[gi], t); }
            catch (e) { if (first) skip[g] = e.message; else throw new Error(`Step ${all[g].i + 1} (${op.label}) failed: ${e.message}`); }
          }
          await next.write(t);
        } else {
          if (first) { columns = t.columns; prof = QETL.createProfiler(columns); await write(columns.map(esc).join(',')); }
          else if (t.columns.length !== columns.length) throw new Error('The pipeline produced different columns for different parts of the file.');
          let buf = '';
          for (const r of t.rows) { buf += '\n'; for (let c = 0; c < r.length; c++) { if (c) buf += ','; buf += esc(r[c]); } if (buf.length > 1 << 20) { await write(buf); buf = ''; } }
          if (buf) await write(buf);
          prof.addSample(t.rows); rowsOut += t.rows.length;
          await next.write(t);
        }
        first = false; rows += chunk.rows.length; await flushLedger();
        tick(last ? 'run' : 'fit', rows);
      }
      await next.close();
      if (input) for (const x of [].concat(input)) fs.rmSync(x, { force: true });
      if (last) { await new Promise(r => csv.end(r)); fs.renameSync(outFile + '.part', outFile); break; }
      group.forEach((g, gi) => { fitDone[g] = true; if (!skip[g]) fitted[g] = QETL.OPS[all[g].s.op].fitDone(fitStates[gi]); });
      input = temps[temps.length - 1]; from = f;
      passes = pass + fitIdx.filter(k => !fitDone[k]).length + 2;
    }

    // Output profile, pass 2: over the exact output values (saved above), as the browser profiles its output table.
    pass++; passes = pass;
    if (ledgerOut) { await flushLedger(); await new Promise((res, rej) => { ledgerOut.on('error', rej); ledgerOut.end(res); }); fs.renameSync(opts.ledgerFile + '.part', opts.ledgerFile); ledgerOut = null; }
    prof.decide(); let done = 0; cur.total = fs.statSync(profTemp).size; cur.bytes = 0;
    for await (const t of ChunkFile.read(profTemp, (x) => { cur.bytes = x; })) { prof.add(t.rows); done += t.rows.length; tick('profile', done); }
  } finally {
    QETL.setInPlace(false); QETL.setReasonSink(null);
    if (ledgerOut) { ledgerOut.destroy(); fs.rmSync(opts.ledgerFile + '.part', { force: true }); }
    for (const f of [...temps, profTemp, outFile + '.part']) if (f) fs.rmSync(f, { force: true });
  }
  const results = all.map((x, k) => ({ id: x.s.id, ...(stats[k] || { affected: 0, rowsBefore: 0, rowsAfter: 0 }), ...(skip[k] ? { error: skip[k] } : {}), ...(reasonCounts[k] ? { reasons: [...reasonCounts[k].entries()].sort((a, b) => b[1] - a[1]).slice(0, 20) } : {}) }));
  return { columns, rows: rowsOut, rowsIn, results, profile: prof.finish(), sample: prof.sampleRows(SAMPLE_ROWS), ms: Date.now() - t0 };
}

// Parallel first pass (see lib/bigsegment.js). Used when the file is plain JSONL or Parquet, the pipeline starts with
// row-by-row steps, and more than one worker is allowed. Returns null when it doesn't apply (the normal run does it all).
async function parallelPrefix(file, all, modes, opts, ctx) {
  const W = Math.max(1, Math.floor(opts.workers || 0)), fmt = formatOf(file);
  let prefix = 0; while (prefix < all.length && modes[prefix] === 'row') prefix++;
  if (W < 2 || !prefix || (fmt !== 'jsonl' && fmt !== 'parquet') || isGz(file) || fs.statSync(file).size < (opts.parallelMin ?? 8 * 1024 * 1024)) return null;
  let parts;
  if (fmt === 'jsonl') { const columns = opts.columns || await scanColumns(file); parts = splitRanges(file, W).map(r => ({ start: r.start, end: r.end, columns })); }
  else { const g = (await parquetInfo(file)).rowGroups; if (g < 2) return null; const n = Math.min(W, g); parts = Array.from({ length: n }, (_, i) => ({ groups: [Math.floor(g * i / n), Math.floor(g * (i + 1) / n)] })); }
  if (parts.length < 2) return null;
  const steps = all.slice(0, prefix).map(x => x.s), stepNo = all.slice(0, prefix).map(x => x.i + 1), labels = steps.map(s => QETL.OPS[s.op].label);
  const total = fs.statSync(file).size, prog = parts.map(() => ({ rows: 0, bytes: 0 }));
  const files = parts.map((_, i) => path.join(ctx.tmpDir, `${ctx.tag}.par${i}.tmp`)), ledgers = parts.map((_, i) => ctx.ledgerOut ? path.join(ctx.tmpDir, `${ctx.tag}.par${i}.ledger.tmp`) : null);
  const workers = [];
  try {
    const results = await Promise.all(parts.map((p, i) => new Promise((resolve, reject) => {
      const w = new Worker(path.join(__dirname, 'bigsegment.js'), { workerData: { file, format: fmt, ...p, steps, stepNo, labels, batch: opts.batch || BATCH, out: files[i], ledger: ledgers[i] }, resourceLimits: { maxOldGenerationSizeMb: 1536 } });
      workers.push(w);
      w.on('message', (m) => {
        if (m.progress) { prog[i] = m.progress; ctx.tick(prog.reduce((a, x) => a + x.rows, 0), Math.min(total, prog.reduce((a, x) => a + x.bytes, 0)), total); }
        else if (m.done) resolve(m.done); else if (m.error) reject(new Error(m.error));
      });
      w.on('error', reject); w.on('exit', (code) => { if (code) reject(new Error('A parallel worker stopped unexpectedly.')); });
    })));
    let rowsIn = 0;
    results.forEach((r) => {
      rowsIn += r.rowsIn;
      r.stats.forEach((s, k) => {
        const st = ctx.stats[k] || (ctx.stats[k] = { affected: 0, rowsBefore: 0, rowsAfter: 0 }), op = QETL.OPS[steps[k].op];
        st.affected = op.affectedOnce ? s.affected : st.affected + s.affected; st.rowsBefore += s.rowsBefore; st.rowsAfter += s.rowsAfter;
        const m = ctx.reasonCounts[k] || (ctx.reasonCounts[k] = new Map()); for (const [why, n] of s.reasons) m.set(why, (m.get(why) || 0) + n);
      });
    });
    if (ctx.ledgerOut) for (const f of ledgers) { for await (const c of fs.createReadStream(f, { highWaterMark: 1 << 20 })) if (!ctx.ledgerOut.write(c)) await new Promise(r => ctx.ledgerOut.once('drain', r)); fs.rmSync(f, { force: true }); }
    return { parts: files, prefix, rowsIn };
  } catch (e) {
    for (const w of workers) w.terminate();
    for (const f of [...files, ...ledgers]) if (f) fs.rmSync(f, { force: true });
    throw e;
  }
}

/**
 * Converts a file (any readable format) to JSONL or Parquet in two passes: the first decides each column's type
 * (QETL.TypeGuess, the same rules as the console's export), the second writes. opts: delimiter, columns,
 * only (JSONL: write just this column's value per line, for fine-tuning records), onProgress.
 * Returns { rows, bytes, types }.
 */
async function convertFile(file, format, outFile, opts = {}) {
  const delimiter = opts.delimiter || await delimiterFor(file, opts.name);
  const cur = { bytes: 0, total: fs.statSync(file).size };
  const tick = (phase, pass, rows) => opts.onProgress && opts.onProgress({ phase, pass, passes: 2, rows, bytes: cur.bytes, totalBytes: cur.total });
  let known = opts.columns;
  const src = () => readAny(file, { delimiter, columns: known, batch: opts.batch || BATCH, onBytes: (x) => { cur.bytes = x; } });
  let guesses = null, columns = null, n = 0;
  for await (const b of src()) {
    if (!guesses) { columns = b.columns; guesses = columns.map(() => new QETL.TypeGuess()); }
    for (const r of b.rows) for (let c = 0; c < columns.length; c++) guesses[c].add(r[c]);
    n += b.rows.length; tick('types', 1, n);
  }
  if (!columns) throw new Error('The file is empty.');
  known = columns;
  const part = outFile + '.part'; let rows = 0; cur.bytes = 0;
  try {
    if (format === 'parquet') {
      const types = guesses.map(g => g.type()), w = new ParquetWriter(part, columns, types);
      for await (const b of src()) { w.add(b.rows); rows += b.rows.length; tick('write', 2, rows); }
      w.close(); fs.renameSync(part, outFile); return { rows, bytes: fs.statSync(outFile).size, types };
    }
    if (format !== 'jsonl') throw new Error('Unknown export format ' + format);
    const kinds = guesses.map(g => g.jsonKind()), oi = opts.only ? columns.indexOf(opts.only) : -1;
    if (opts.only && oi < 0) throw new Error(`Column ${opts.only} isn't in the output.`);
    const line = oi >= 0 ? (r) => (QETL.isNull(r[oi]) ? null : kinds[oi] === 'json' ? JSON.stringify(JSON.parse(r[oi])) : JSON.stringify(r[oi])) : QETL.jsonlWriter(columns, kinds);
    const out = fs.createWriteStream(part, { highWaterMark: 1 << 22 });
    const write = (x) => (out.write(x) ? null : new Promise(r => out.once('drain', r)));
    for await (const b of src()) {
      let buf = '';
      for (const r of b.rows) { const l = line(r); if (l === null) continue; buf += l + '\n'; rows++; if (buf.length > 1 << 20) { await write(buf); buf = ''; } }
      if (buf) await write(buf);
      tick('write', 2, rows);
    }
    await new Promise((res, rej) => { out.on('error', rej); out.end(res); });
    fs.renameSync(part, outFile); return { rows, bytes: fs.statSync(outFile).size, types: kinds };
  } finally { fs.rmSync(part, { force: true }); }
}

/** Texts of one column, from a file (streamed) or given directly. */
async function* textsOf(src, onBytes) {
  if (src.texts) { yield src.texts; return; }
  const delimiter = src.delimiter || await delimiterFor(src.file, src.name); let ci = -1;
  for await (const b of readAny(src.file, { delimiter, batch: BATCH, onBytes })) {
    if (ci < 0) { ci = b.columns.indexOf(src.column); if (ci < 0) throw new Error(`Column "${src.column}" not found.`); }
    yield b.rows.map(r => r[ci]);
  }
}
/**
 * Contamination check between a training source and an evaluation source ({ file, column, delimiter } or { texts }).
 * The evaluation side is held in memory (up to 500,000 texts); the training side is streamed.
 */
async function contaminateFiles(train, evalSrc, opts = {}) {
  const evalTexts = [];
  for await (const part of textsOf(evalSrc)) { for (const x of part) evalTexts.push(x); if (evalTexts.length > 500000) throw new Error('The evaluation data has more than 500,000 rows. Use a smaller evaluation set.'); }
  const c = QETL.createContamination(evalTexts, { ngram: opts.ngram || 13, minOverlap: opts.minOverlap || 0 }); let rows = 0, total = train.file ? fs.statSync(train.file).size : 0;
  for await (const part of textsOf(train, (b) => opts.onProgress && opts.onProgress({ phase: 'contamination', rows, bytes: b, totalBytes: total }))) { c.add(part); rows += part.length; }
  const r = c.finish();
  return { ...r, rows: r.rows.slice(0, 2000).map(x => ({ ...x, text: String(evalTexts[x.index] ?? '').slice(0, 200) })) };
}

module.exports = { QETL, profileFile, runFile, convertFile, contaminateFiles, readAny, formatOf, unsupportedSteps, LimitError, isGz, SAMPLE_ROWS };
