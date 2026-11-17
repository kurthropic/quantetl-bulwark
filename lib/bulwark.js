// QuantETL Bulwark: the terminal edition, for air-gapped and defence networks. Everything runs on this computer with
// the same engine as the console; the only command that ever opens a network connection is `depot`, and only to a
// QuantETL server you name. State lives in ~/.bulwark (or $BULWARK_HOME): signing keys per user, the hash-chained
// activity record (Cairn) and classification markings.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const readline = require('readline');
const E = require('./bigengine');
const { QETL, QGuard, QAI, QDiff } = require('./browserlibs');
const Provenance = require('./provenance');
const Share = require('./share');
const { parquetInfo, isParquet } = require('./parquet');

const VERSION = 'v1.12 Beta Release 01';
const HOME = process.env.BULWARK_HOME || path.join(os.homedir(), '.bulwark');
const TTY = process.stdout.isTTY && !process.env.NO_COLOR;
const C = (code) => (s) => (TTY ? `\x1b[${code}m${s}\x1b[0m` : String(s));
const bold = C('1'), dim = C('2'), blue = C('38;5;69'), green = C('32'), red = C('31'), yellow = C('33');
const n0 = (x) => Number(x || 0).toLocaleString('en-US');
const pct = (x, d = 1) => (x * 100).toFixed(d) + '%';
class Fail extends Error {}

/* ---------- state: keys, markings, activity record ---------- */
const me = (o) => (o.as || process.env.BULWARK_USER || os.userInfo().username).replace(/[^\w.\-@]/g, '_');
function keysFor(user) { return Provenance.loadKeys(path.join(HOME, 'keys', user)); }
const STATE = path.join(HOME, 'markings.json'), CAIRN = path.join(HOME, 'cairn.jsonl');
function readJSON(f, d) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } }
function writeJSON(f, v) { fs.mkdirSync(path.dirname(f), { recursive: true, mode: 0o700 }); fs.writeFileSync(f, JSON.stringify(v, null, 2) + '\n', { mode: 0o600 }); }

// Classification markings. Levels are ordered; the highest of the inputs carries to every output. Caveats add up.
const LEVELS = ['UNCLASSIFIED', 'CUI', 'CONFIDENTIAL', 'SECRET', 'TOP SECRET'];
const LEVEL_COLOR = { UNCLASSIFIED: '42;30', CUI: '45;97', CONFIDENTIAL: '44;97', SECRET: '41;97', 'TOP SECRET': '43;30' };
function parseMarking(s) {
  const parts = String(s || '').toUpperCase().split('//').map(x => x.trim()).filter(Boolean);
  const level = parts.shift(); if (!level) return null;
  if (!LEVELS.includes(level)) throw new Fail(`Unknown marking level "${level}". Use one of: ${LEVELS.join(', ')} (add caveats with //, e.g. "CUI//NOFORN").`);
  return { level, caveats: [...new Set(parts)] };
}
const markingText = (m) => (m ? [m.level, ...m.caveats].join('//') : null);
function maxMarking(list) {
  const ms = list.filter(Boolean); if (!ms.length) return null;
  const level = ms.reduce((a, m) => (LEVELS.indexOf(m.level) > LEVELS.indexOf(a) ? m.level : a), 'UNCLASSIFIED');
  return { level, caveats: [...new Set(ms.flatMap(m => m.caveats))].sort() };
}
function markingOf(file) { const st = readJSON(STATE, {}); return (file && st.files && st.files[path.resolve(file)]) || st.default || null; }
function setMarking(file, m) { const st = readJSON(STATE, {}); st.files = st.files || {}; if (file) st.files[path.resolve(file)] = m; else st.default = m; writeJSON(STATE, st); }
// Startup splash in the logo's teal (256-colour 31 approximates #0399b5), with the version from the logo.
function splash() {
  const t = (s) => (TTY ? `\x1b[48;5;31;97;1m${s}\x1b[0m` : s), w = 46;
  out(t(' '.repeat(w))); out(t('  ▄▀▄▀  B U L W A R K'.padEnd(w))); out(t(`  ▀▄▀▄  ${VERSION}`.padEnd(w))); out(t(' '.repeat(w)));
}
function banner(m) { if (!m) return; const t = ` ${markingText(m)} `, w = Math.max(t.length + 4, Math.min(process.stdout.columns || 80, 100)); const pad = ' '.repeat(Math.floor((w - t.length) / 2)); const line = pad + t + ' '.repeat(w - t.length - pad.length); process.stdout.write((TTY ? `\x1b[${LEVEL_COLOR[m.level]};1m${line}\x1b[0m` : `[${markingText(m)}]`) + '\n'); }

// Cairn: the activity record. One JSON line per action; each holds the SHA-256 of the previous one.
const cairnBody = (e) => JSON.stringify([e.seq, e.at, e.user, e.action, e.target || null, e.detail || null, e.prev]);
function cairnRead() { try { return fs.readFileSync(CAIRN, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch { return []; } }
function cairn(user, action, target, detail) {
  const all = cairnRead(), last = all[all.length - 1];
  const e = { seq: last ? last.seq + 1 : 1, at: Date.now(), user, action, target: target || null, detail: detail ? String(detail).slice(0, 500) : null, prev: last ? last.hash : '0'.repeat(64) };
  e.hash = crypto.createHash('sha256').update(cairnBody(e)).digest('hex');
  fs.mkdirSync(HOME, { recursive: true, mode: 0o700 }); fs.appendFileSync(CAIRN, JSON.stringify(e) + '\n', { mode: 0o600 });
}
function cairnVerify() {
  let prev = '0'.repeat(64), seq = 0; const all = cairnRead();
  for (const e of all) {
    if (e.seq !== seq + 1) return { ok: false, entries: all.length, at: seq + 1, reason: `Entry ${seq + 1} is missing.` };
    if (e.prev !== prev) return { ok: false, entries: all.length, at: e.seq, reason: `Entry ${e.seq} doesn't follow entry ${seq}.` };
    if (crypto.createHash('sha256').update(cairnBody(e)).digest('hex') !== e.hash) return { ok: false, entries: all.length, at: e.seq, reason: `Entry ${e.seq} was changed after it was written.` };
    prev = e.hash; seq = e.seq;
  }
  return { ok: true, entries: all.length, head: prev };
}

/* ---------- output helpers ---------- */
function table(rows, head) {
  const all = [head, ...rows].map(r => r.map(c => String(c ?? '')));
  const w = head.map((_, i) => Math.min(60, Math.max(...all.map(r => strip(r[i]).length))));
  const fmt = (r, b) => r.map((c, i) => { const s = strip(c).length > w[i] ? c.slice(0, w[i] - 1) + '…' : c; const pad = ' '.repeat(Math.max(0, w[i] - strip(s).length)); return /^[-−+]?[\d,.]+%?$/.test(strip(s)) ? pad + s : s + pad; }).join('  ');
  return [bold(fmt(all[0])), dim(w.map(x => '─'.repeat(x)).join('  ')), ...all.slice(1).map(r => fmt(r))].join('\n');
}
function strip(s) { return String(s).replace(/\x1b\[[0-9;]*m/g, ''); }
const out = (s = '') => process.stdout.write(s + '\n');
const section = (t) => out('\n' + blue('▍') + bold(t));
let lastProg = 0;
function progress(label) {
  const t0 = Date.now();
  return (p) => {
    if (!process.stderr.isTTY) return; const now = Date.now(); if (now - lastProg < 200) return; lastProg = now;
    const f = p.totalBytes ? Math.min(1, (p.bytes || 0) / p.totalBytes) : 0, s = (now - t0) / 1000;
    process.stderr.write(`\r${dim(label)} ${p.phase || ''}${p.pass ? ` ${p.pass}/${p.passes}` : ''} · ${n0(p.rows || 0)} rows · ${(f * 100).toFixed(0)}% · ${((p.bytes || 0) / 1e6 / Math.max(s, 0.1)).toFixed(1)} MB/s   `);
  };
}
const endProgress = () => { if (process.stderr.isTTY) process.stderr.write('\r' + ' '.repeat(90) + '\r'); };

/* ---------- arguments ---------- */
function parseArgs(argv) {
  const a = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i];
    if (x === '-o') a.o = argv[++i];
    else if (x.startsWith('--')) { const [k, v] = x.slice(2).split(/=(.*)/s); const key = k.replace(/-([a-z])/g, (_, c) => c.toUpperCase()); if (v !== undefined) a[key] = v; else if (argv[i + 1] !== undefined && !argv[i + 1].startsWith('--') && !['json', 'yes', 'iHaveTheRights', 'twoPerson', 'allowSensitive', 'force'].includes(key)) a[key] = argv[++i]; else a[key] = true; }
    else a._.push(x);
  }
  return a;
}
function tokenize(line) { const r = []; let cur = '', q = null, any = false; for (const ch of line) { if (q) { if (ch === q) q = null; else cur += ch; } else if (ch === '"' || ch === "'") { q = ch; any = true; } else if (/\s/.test(ch)) { if (cur || any) { r.push(cur); cur = ''; any = false; } } else cur += ch; } if (cur || any) r.push(cur); return r; }
function need(file, what = 'a file') { if (!file) throw new Fail(`Give ${what}.`); if (!fs.existsSync(file)) throw new Fail(`No such file: ${file}`); return file; }
const fmtOf = (f) => (isParquet(f) ? 'parquet' : /\.(jsonl|ndjson)(\.gz)?$/i.test(f) ? 'jsonl' : 'csv');

/* ---------- shared work ---------- */
async function load(file) { // full-file profile (exact counts) plus a sample table for scans and previews
  const r = await E.profileFile(file, { name: file, onProgress: progress('Reading') }); endProgress();
  return { file, columns: r.columns, rows: r.rows, profile: r.profile, sample: { columns: r.columns, rows: r.sample }, delimiter: r.delimiter, sampled: r.sample.length < r.rows };
}
function readRecipe(f) { const j = readJSON(need(f, 'a recipe file'), null); if (!j || !Array.isArray(j.steps)) throw new Fail(`${f} is not a recipe (it needs a "steps" list).`); return j; }
function writeRecipe(f, steps, extra = {}) { writeJSON(f, { quantetl: 1, tool: 'bulwark', ...extra, steps: steps.map(({ op, params, reason, disabled }) => ({ op, params, ...(reason ? { reason } : {}), ...(disabled ? { disabled } : {}) })) }); }
function parseParams(op, kv) {
  const def = QETL.OPS[op]; if (!def) throw new Fail(`Unknown step "${op}". See: bulwark crucible ops`);
  const p = {};
  for (const x of kv) {
    const m = /^([\w]+)=(.*)$/s.exec(x); if (!m) throw new Fail(`Settings look like key=value (got "${x}").`);
    const d = def.params.find(q => q.k === m[1]); if (!d) throw new Fail(`${op} has no setting "${m[1]}". It takes: ${def.params.map(q => q.k).join(', ') || 'nothing'}.`);
    p[m[1]] = d.t === 'columns' ? m[2].split(',').map(s => s.trim()).filter(Boolean) : d.t === 'number' ? +m[2] : d.t === 'bool' ? /^(1|true|yes)$/i.test(m[2]) : m[2];
  }
  return p;
}
async function runTo(file, steps, outFile, o = {}) { // full-file run; output format from the extension
  const outFmt = fmtOf(outFile), tmpCsv = outFmt === 'csv' ? outFile : outFile + '.bulwark-tmp.csv';
  const r = await E.runFile(file, steps, tmpCsv, { name: file, ledgerFile: o.ledger, workers: +o.workers || 1, onProgress: progress('Running') }); endProgress();
  if (outFmt !== 'csv') { await E.convertFile(tmpCsv, outFmt, outFile, { delimiter: ',', onProgress: progress('Writing') }); endProgress(); fs.rmSync(tmpCsv, { force: true }); }
  return r;
}

/* ---------- commands ---------- */
const CMDS = {};
const cmd = (name, usage, about, fn) => { CMDS[name] = { name, usage, about, fn }; };

cmd('census', 'census <file> [--json]', 'Profile every column with exact counts, and give a quality score (Census).', async (a) => {
  const f = need(a._[0]); const d = await load(f); const p = d.profile;
  if (a.json) return out(JSON.stringify({ rows: d.rows, columns: d.columns.length, score: p.score, completeness: p.completeness, validity: p.validity, uniqueness: p.uniqueness, consistency: p.consistency, profile: p.columns.map(c => ({ name: c.name, type: c.type, nulls: c.nulls, unique: c.unique, issues: c.issues.map(i => i.msg) })) }, null, 2));
  section(`Census · ${path.basename(f)}`);
  out(`${bold(n0(d.rows))} rows × ${bold(d.columns.length)} columns · quality ${bold(p.score)}/100 · completeness ${pct(p.completeness)} · validity ${pct(p.validity)} · uniqueness ${pct(p.uniqueness)} · consistency ${pct(p.consistency)}\n`);
  out(table(p.columns.map(c => [c.name, c.type, pct(c.nullPct), n0(c.unique), c.issues.length ? yellow(c.issues[0].msg) : dim('—')]), ['column', 'type', 'missing', 'distinct', 'first issue']));
});

cmd('assay', 'assay <file> [--column c] [--json]', 'Training-readiness: duplicates, low-quality text, personal data, languages, length (Assay).', async (a) => {
  const f = need(a._[0]); const d = await load(f), col = a.column || QAI.pickTextColumn(d.sample);
  if (!col) throw new Fail('No text column found. Name one with --column.');
  const r = await QAI.readiness(d.sample, col, { totalRows: d.rows });
  if (a.json) return out(JSON.stringify(r, null, 2));
  const docs = Math.max(1, r.examined - r.empty), mark = (bad) => (bad ? red('✗') : green('✓'));
  section(`Assay · ${path.basename(f)} · ${col}`);
  out(`Training readiness ${bold(r.score)}/100 · ${n0(r.totalRows)} documents · ~${n0(r.estTotalTokens)} tokens (estimated)${r.sampled ? dim(` · ${n0(r.examined)} examined`) : ''}\n`);
  out(`${mark(r.piiDocs)} Personal data      ${pct(r.piiDocs / docs)}  ${dim(Object.entries(r.pii).map(([k, n]) => `${n} ${k}`).join(', '))}`);
  out(`${mark(r.failed)} Low quality        ${pct(r.failed / docs)}  ${dim(Object.entries(r.quality).sort((x, y) => y[1] - x[1]).slice(0, 3).map(([k, n]) => `${k} ${n}`).join('; '))}`);
  out(`${mark(r.exact + r.near)} Duplicates         ${pct((r.exact + r.near) / docs)}  ${dim(`${r.exact} exact, ${r.near} near`)}`);
  out(`${mark(r.empty)} Empty              ${n0(r.empty)}`);
  out(`${dim('·')} Languages          ${r.langList.slice(0, 5).map(l => `${l.name} ${pct(l.share, 0)}`).join(', ')}`);
  out(`${dim('·')} Length             median ${r.words.median} words, 95% under ${r.words.p95}`);
  out(dim(`\nNext: bulwark crucible prepare ${f} -o recipe.json`));
});

cmd('veil', 'veil scan <file> | veil protect <file> -o <out> [--recipe r.json]', 'Find personal data and re-identification risk; protect it (Veil).', async (a, ctx) => {
  const [action, f0] = a._;
  if (action !== 'scan' && action !== 'protect') throw new Fail('Use: bulwark veil scan <file>  or  bulwark veil protect <file> -o <out>');
  const f = need(f0); const d = await load(f), sc = QGuard.scanPrivacy(d.sample, QETL.profile(d.sample));
  if (action === 'scan') {
    if (a.json) return out(JSON.stringify(Share.privacySummary(sc), null, 2));
    section(`Veil · ${path.basename(f)}`);
    out(`Privacy risk ${bold(sc.risk)}/100 (${sc.level})${d.sampled ? dim(` · ${n0(sc.rowsScanned)} rows scanned`) : ''}\n`);
    if (sc.findings.length) out(table(sc.findings.map(x => [x.column, x.category, x.label || x.kind, x.confidence, x.embedded ? x.embedded.kinds.map(k => k.kind).join(', ') : '']), ['column', 'category', 'found', 'confidence', 'inside text']));
    else out(green('No personal data found.'));
    if (sc.reid) out(`\nRe-identification: ${sc.reid.k < 5 ? red(`k = ${sc.reid.k}`) : green(`k = ${sc.reid.k}`)} on ${sc.reid.columns.join(' + ')} · ${pct(sc.reid.uniquePct)} of rows unique`);
    return;
  }
  const o = a.o || a.out; if (!o) throw new Fail('Give an output file with -o.');
  const prot = QGuard.protectionSteps(sc.findings.filter(x => x.fix), crypto.randomBytes(16).toString('hex')).map(s => ({ ...s, id: crypto.randomBytes(4).toString('hex') }));
  const steps = [...(a.recipe ? readRecipe(a.recipe).steps : []), ...prot];
  if (!prot.length) out(green('Nothing to protect.'));
  const r = await runTo(f, steps, o, a); setMarking(o, maxMarking([markingOf(f)]));
  out(`${green('✓')} Protected ${prot.length} column group(s): ${prot.map(s => QETL.OPS[s.op].describe(s.params)).join('; ')}`);
  out(`${n0(r.rowsIn)} rows in, ${n0(r.rows)} out → ${o}`);
  cairn(ctx.user, 'veil.protect', o, `${f} · ${prot.length} steps`);
});

cmd('crucible', 'crucible ops | new <recipe> | add <recipe> <op> key=value… | show <recipe> | remove <recipe> <n> | prepare <file> -o <recipe> [--column c] | run <file> --recipe <r> -o <out> [--ledger l.csv] [--workers n]', 'Build recipes of steps and run them over whole files (Crucible).', async (a, ctx) => {
  const [action, x, ...rest] = a._;
  if (action === 'ops') { section('Steps'); const g = {}; for (const [k, o] of Object.entries(QETL.OPS)) (g[o.group] = g[o.group] || []).push([k, o]); for (const [grp, list] of Object.entries(g)) { out('\n' + bold(grp)); for (const [k, o] of list) out(`  ${blue(k.padEnd(22))} ${o.label}${o.params.length ? dim('  ' + o.params.map(p => p.k).join(' ')) : ''}`); } return; }
  if (action === 'new') { if (!x) throw new Fail('Give a recipe file name.'); writeRecipe(x, []); return out(`${green('✓')} Created ${x}`); }
  if (action === 'add') { const r = readRecipe(x), [op, ...kv] = rest; r.steps.push({ op, params: parseParams(op, kv) }); writeRecipe(x, r.steps); return out(`${green('✓')} Step ${r.steps.length}: ${QETL.OPS[op].describe(r.steps[r.steps.length - 1].params)}`); }
  if (action === 'remove') { const r = readRecipe(x), k = +rest[0] - 1; if (!(k >= 0 && k < r.steps.length)) throw new Fail('No such step number.'); const [s] = r.steps.splice(k, 1); writeRecipe(x, r.steps); return out(`${green('✓')} Removed: ${QETL.OPS[s.op] ? QETL.OPS[s.op].describe(s.params || {}) : s.op}`); }
  if (action === 'show') { const r = readRecipe(x); section(`Recipe · ${x}`); if (!r.steps.length) return out(dim('No steps yet.')); r.steps.forEach((s, i) => out(`${dim(String(i + 1).padStart(2))}  ${QETL.OPS[s.op] ? QETL.OPS[s.op].describe(s.params || {}) : red('unknown step ' + s.op)}${s.reason ? '\n    ' + dim(s.reason) : ''}`)); return; }
  if (action === 'prepare') {
    const f = need(x), o = a.o || a.out; if (!o) throw new Fail('Give a recipe file with -o.');
    const d = await load(f), col = a.column || QAI.pickTextColumn(d.sample); if (!col) throw new Fail('No text column found. Name one with --column.');
    const r = await QAI.readiness(d.sample, col, { totalRows: d.rows }), sc = QGuard.scanPrivacy(d.sample, QETL.profile(d.sample));
    const prot = QGuard.protectionSteps(sc.findings.filter(z => z.fix && z.column !== col), crypto.randomBytes(16).toString('hex')).map(s => ({ ...s, reason: 'Protects personal data found by Veil.' }));
    const steps = [...prot, ...QAI.bundle(r, prot).map(b => ({ op: b.op, params: b.params, reason: b.reason }))];
    writeRecipe(o, steps, { source: path.basename(f), column: col });
    section(`Crucible · recipe for ${path.basename(f)}`); steps.forEach((s, i) => out(`${dim(String(i + 1).padStart(2))}  ${QETL.OPS[s.op].describe(s.params)}\n    ${dim(s.reason || '')}`));
    out(`\n${green('✓')} Saved ${o}. Edit it with "crucible add/remove", then: bulwark crucible run ${f} --recipe ${o} -o out.jsonl`);
    return;
  }
  if (action === 'run') {
    const f = need(x), o = a.o || a.out; if (!o) throw new Fail('Give an output file with -o (.jsonl, .parquet or .csv).');
    const steps = readRecipe(a.recipe).steps.map(s => ({ ...s, id: s.id || crypto.randomBytes(4).toString('hex') }));
    const ledger = a.ledger || o.replace(/(\.\w+)?$/, '') + '.ledger.csv', t0 = Date.now();
    const r = await runTo(f, steps, o, { ...a, ledger });
    const m = maxMarking([markingOf(f)]); if (m) setMarking(o, m);
    section(`Crucible · ${path.basename(f)} → ${path.basename(o)}`);
    out(table(r.results.map((x, i) => [i + 1, QETL.OPS[steps[i].op].label, n0(x.rowsAfter), x.rowsBefore - x.rowsAfter ? '−' + n0(x.rowsBefore - x.rowsAfter) : '0', x.error ? red(x.error) : (x.reasons || []).slice(0, 2).map(([k, n]) => `${k} ${n0(n)}`).join('; ')]), ['#', 'step', 'rows after', 'removed', 'why']));
    out(`\n${green('✓')} ${n0(r.rowsIn)} rows in, ${bold(n0(r.rows))} out in ${((Date.now() - t0) / 1000).toFixed(1)} s → ${o}\n  Ledger: ${ledger}${m ? `\n  Marking carried: ${markingText(m)}` : ''}`);
    cairn(ctx.user, 'crucible.run', o, `${f} · ${steps.length} steps · ${r.rowsIn} → ${r.rows} rows`);
    return;
  }
  throw new Fail('Use one of: ops, new, add, show, remove, prepare, run.');
});

cmd('tripwire', 'tripwire <training file> --eval <file> [--column c] [--eval-column c] [--json]', 'Leak check: evaluation rows that also appear in training data (Tripwire).', async (a, ctx) => {
  const f = need(a._[0], 'a training file'), ev = need(a.eval, 'an evaluation file with --eval');
  const pick = async (file, col) => { if (col) return col; const d = await load(file); return QAI.pickTextColumn(d.sample) || d.columns[0]; };
  const col = await pick(f, a.column), ecol = await pick(ev, a.evalColumn);
  const r = await E.contaminateFiles({ file: f, column: col, name: f }, { file: ev, column: ecol, name: ev }, { onProgress: progress('Checking') }); endProgress();
  if (a.json) return out(JSON.stringify(r, null, 2));
  section(`Tripwire · ${path.basename(ev)} vs ${path.basename(f)}`);
  out(r.contaminated ? `${red('✗')} ${bold(n0(r.contaminated))} of ${n0(r.evalRows)} evaluation rows (${pct(r.contaminated / r.evalRows)}) appear in the training data: ${n0(r.exact)} exact copies, ${n0(r.contaminated - r.exact)} share a 13-word passage.` : `${green('✓')} None of the ${n0(r.evalRows)} evaluation rows appear in ${n0(r.trainRows)} training rows.`);
  if (r.contaminated) { out(''); out(table(r.rows.slice(0, 12).map(x => [x.index + 1, x.exact ? red('exact') : yellow(pct(x.overlap, 0)), x.trainRow + 1, x.text]), ['eval row', 'overlap', 'train row', 'text'])); }
  cairn(ctx.user, 'tripwire.check', ev, `${r.contaminated} of ${r.evalRows} overlap with ${f}`);
});

cmd('ledger', 'ledger <ledger.csv>', 'Summarise a removal ledger: what each step removed, and why (Ledger).', async (a) => {
  const f = need(a._[0]); const t = QETL.parseCSV(fs.readFileSync(f, 'utf8')), si = t.columns.indexOf('step_name') >= 0 ? t.columns.indexOf('step_name') : t.columns.indexOf('step'), ri = t.columns.indexOf('reason');
  const g = new Map(); for (const r of t.rows) { const k = r[si] + '\u0000' + r[ri]; g.set(k, (g.get(k) || 0) + 1); }
  section(`Ledger · ${path.basename(f)} · ${n0(t.rows.length)} removed rows`);
  out(table([...g.entries()].sort((x, y) => y[1] - x[1]).map(([k, n]) => [...k.split('\u0000'), n0(n)]), ['step', 'reason', 'rows']));
});

cmd('signet', 'signet sign <output> [--source f] [--recipe r] -o manifest.json | signet verify <manifest> [--output f] [--source f] [--key pub] | signet key', 'Sign what went in, what ran and what came out; verify it anywhere (Signet).', async (a, ctx) => {
  const [action, x] = a._;
  if (action === 'key') { const k = keysFor(ctx.user); section('Signet key'); out(`User ${bold(ctx.user)} · Ed25519 key ID ${bold(k.keyId)}\nPublic key: ${path.join(HOME, 'keys', ctx.user, 'provenance.pub')}\nShare the public key (never provenance.key) so others can check your signatures.`); return; }
  if (action === 'sign') {
    const f = need(x, 'the output file to sign'), k = keysFor(ctx.user), steps = a.recipe ? readRecipe(a.recipe).steps : [];
    const m = maxMarking([markingOf(f), a.source ? markingOf(a.source) : null]);
    const man = Provenance.sign({ quantetl_manifest: 1, tool: `bulwark ${VERSION}`, dataset: { name: path.basename(f) },
      ...(a.source ? { source: { name: path.basename(a.source), bytes: fs.statSync(need(a.source)).size, sha256: await Provenance.sha256File(a.source), hash_of: 'the source file' } } : {}),
      steps: steps.filter(s => QETL.OPS[s.op]).map(s => ({ op: s.op, params: s.params || {}, describe: QETL.OPS[s.op].describe(s.params || {}) })),
      output: { name: path.basename(f), bytes: fs.statSync(f).size, sha256: await Provenance.sha256File(f), hash_of: 'the output file' },
      ...(m ? { marking: markingText(m) } : {}), engine: Provenance.engineInfo(path.join(__dirname, '..')), created: new Date().toISOString(), signed_by: { user: ctx.user, key_id: k.keyId } }, k);
    const o = a.o || a.out || f.replace(/(\.\w+)?$/, '') + '.manifest.json'; writeJSON(o, man);
    out(`${green('✓')} Signed ${path.basename(f)} with key ${k.keyId} → ${o}`); cairn(ctx.user, 'signet.sign', f, `sha256 ${man.output.sha256}`); return;
  }
  if (action === 'verify') {
    const m = readJSON(need(x, 'a manifest'), null); if (!m) throw new Fail('That file is not a manifest.');
    const v = Provenance.verify(m, a.key ? fs.readFileSync(need(a.key), 'utf8') : null); let bad = !v.ok;
    if (m.marking) banner(parseMarking(m.marking));
    out(`${v.ok ? green('✓') : red('✗')} Signature ${v.ok ? 'valid' : 'NOT valid'}${v.keyId ? ` · key ${v.keyId}${a.key ? ' (pinned)' : dim(' (embedded key: compare with the signer\'s published key ID)')}` : ''}${v.ok ? '' : ' · ' + v.reason}`);
    for (const [lab, file, part] of [['output', a.output, m.output], ['source', a.source, m.source]]) { if (!file) continue; const h = await Provenance.sha256File(need(file)), ok = part && h === part.sha256; if (!ok) bad = true; out(`${ok ? green('✓') : red('✗')} ${lab} ${path.basename(file)} ${ok ? 'matches' : 'does NOT match'}`); }
    if (m.steps && m.steps.length) { out(''); m.steps.forEach((s, i) => out(dim(`  ${i + 1}. ${s.describe || s.op}`))); }
    if (bad) throw new Fail('Verification failed.'); return;
  }
  throw new Fail('Use: signet sign | signet verify | signet key');
});

cmd('cairn', 'cairn log [--n 20] | cairn verify | cairn export [-o file.jsonl]', 'The tamper-evident activity record of this computer (Cairn).', async (a) => {
  const [action] = a._;
  if (action === 'verify') { const v = cairnVerify(); out(v.ok ? `${green('✓')} Chain intact · ${n0(v.entries)} entries · head ${v.head.slice(0, 16)}…` : `${red('✗')} Chain broken at entry ${v.at}: ${v.reason}`); if (!v.ok) throw new Fail('The activity record has been altered.'); return; }
  if (action === 'export') { const lines = cairnRead().map(e => JSON.stringify({ ...e, time: new Date(e.at).toISOString(), source: 'quantetl-bulwark', host: os.hostname() })).join('\n') + '\n'; if (a.o) { fs.writeFileSync(a.o, lines); out(`${green('✓')} Wrote ${n0(cairnRead().length)} entries to ${a.o} (JSON Lines, ready for a SIEM)`); } else process.stdout.write(lines); return; }
  const all = cairnRead(), k = +a.n || 20; section(`Cairn · last ${Math.min(k, all.length)} of ${n0(all.length)}`);
  out(table(all.slice(-k).reverse().map(e => [e.seq, new Date(e.at).toISOString().replace('T', ' ').slice(0, 19), e.user, e.action, e.target ? path.basename(e.target) : '', dim(e.hash.slice(0, 10))]), ['#', 'time (UTC)', 'user', 'action', 'target', 'hash']));
});

cmd('mark', 'mark <file> <MARKING> | mark default <MARKING> | mark show <file> | mark list', 'Classification markings, e.g. CUI or SECRET//NOFORN; the highest input marking carries to outputs.', async (a, ctx) => {
  const [x, y] = a._;
  if (x === 'list') { const st = readJSON(STATE, {}); section('Markings'); if (st.default) out(`default  ${markingText(st.default)}`); out(table(Object.entries(st.files || {}).map(([f, m]) => [markingText(m), f]), ['marking', 'file'])); return; }
  if (x === 'show') { const m = markingOf(need(y)); banner(m); if (!m) out(dim('No marking.')); return; }
  if (x === 'default') { const m = parseMarking(y); setMarking(null, m); banner(m); out(`${green('✓')} Default marking for unmarked files: ${markingText(m)}`); cairn(ctx.user, 'mark.default', null, markingText(m)); return; }
  const f = need(x), m = parseMarking(y); if (!m) throw new Fail('Give a marking, e.g. CUI.');
  setMarking(f, m); banner(m); out(`${green('✓')} ${path.basename(f)} marked ${markingText(m)}`); cairn(ctx.user, 'mark.set', f, markingText(m));
});

cmd('courier', 'courier pack <file> --license L --contributor "Name, Org" --i-have-the-rights [--recipe r] [--format jsonl|parquet|csv] [--eval e] [--two-person] [-o bundle.tar.gz] | courier approve <bundle> -o <released.tar.gz> | courier verify <bundle>', 'Sealed share packages for moving data between networks or to research partners (Courier).', async (a, ctx) => {
  const [action, x] = a._;
  if (action === 'verify') {
    const c = await Share.checkBundle(need(x, 'a bundle'));
    if (c.manifest.marking) banner(parseMarking(c.manifest.marking));
    section(`Courier · ${path.basename(x)}`);
    out(table(c.files.map(f => [f.name, n0(f.bytes), f.ok ? green('match') : red(f.present ? 'CHANGED' : 'MISSING')]), ['file', 'bytes', 'sha256']));
    if (c.extra.length) out(red(`Unexpected files: ${c.extra.join(', ')}`));
    out(`\n${c.signature.ok ? green('✓') : red('✗')} Manifest signature ${c.signature.ok ? `valid (key ${c.signature.keyId})` : 'NOT valid: ' + c.signature.reason}`);
    out(`${dim('·')} ${c.manifest.dataset.name} · ${n0(c.manifest.output.rows)} rows · license ${c.manifest.license} · contributed by ${c.manifest.attestation.name}${c.manifest.attestation.org ? ', ' + c.manifest.attestation.org : ''}`);
    if (c.approvalCheck) out(`${c.approvalCheck.ok ? green('✓') : yellow('…')} Two-person release: ${c.approvalCheck.reason}`);
    out(c.ok ? `\n${green(bold('RELEASED'))} Every file matches and every signature checks out.` : `\n${red(bold('NOT RELEASED'))}`);
    if (!c.ok) throw new Fail(c.released ? 'Verification failed.' : 'Waiting for the second approval.'); return;
  }
  if (action === 'approve') {
    const k = keysFor(ctx.user), o = a.o || x.replace(/\.tar\.gz$/i, '') + '.released.tar.gz';
    const ap = await Share.approveBundle(need(x, 'a bundle'), k, { user: ctx.user, name: a.name || ctx.user }, o);
    out(`${green('✓')} Release approved by ${ctx.user} (key ${k.keyId}) → ${o}`); cairn(ctx.user, 'courier.approve', o, `manifest ${ap.manifest_sha256.slice(0, 16)}`); return;
  }
  if (action !== 'pack') throw new Fail('Use: courier pack | courier approve | courier verify');
  const f = need(x), fmt = a.format || 'jsonl', [cname, ...corg] = String(a.contributor || '').split(',').map(s => s.trim());
  const steps = a.recipe ? readRecipe(a.recipe).steps.map(s => ({ ...s, id: crypto.randomBytes(4).toString('hex') })) : [];
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bulwark-')), cleaned = path.join(tmp, 'clean.csv'), ledger = path.join(tmp, 'ledger.csv');
  try {
    let src = f, rowsIn = null;
    if (steps.length) { const r = await runTo(f, steps, cleaned, { ledger }); src = cleaned; rowsIn = r.rowsIn; }
    const d = await load(src);
    let leaks = null;
    if (a.eval) { const col = QAI.pickTextColumn(d.sample); const ed = await load(need(a.eval)); const r = await E.contaminateFiles({ file: src, column: col }, { file: a.eval, column: QAI.pickTextColumn(ed.sample) || ed.columns[0] }); leaks = { contaminated: r.contaminated, evalRows: r.evalRows, name: path.basename(a.eval) }; }
    const gate = Share.shareChecks(d.sample, QETL.profile(d.sample), { license: a.license, attest: { name: cname, org: corg.join(', '), rights: !!a.iHaveTheRights }, allowSensitive: !!a.allowSensitive, sampled: d.sampled, leaks });
    section(`Courier · gate checks for ${path.basename(f)}`);
    for (const c of gate.checks) out(`${c.status === 'pass' ? green('✓') : c.status === 'warn' ? yellow('!') : red('✗')} ${c.label.padEnd(36)} ${dim(c.detail)}${c.fix ? '\n    ' + yellow('→ ' + c.fix) : ''}`);
    if (!gate.ok) throw new Fail('Not packed: fix the failed checks above, then run courier pack again.');
    const m = maxMarking([markingOf(f)]), col = QAI.pickTextColumn(d.sample);
    const report = col ? await QAI.readiness(d.sample, col, { totalRows: d.rows }) : null;
    const card = QAI.datasetCard({ name: path.basename(f), license: a.license, report, steps, out: { rows: d.rows, cols: d.columns.length }, rowsIn: rowsIn ?? d.rows });
    const k = keysFor(ctx.user), o = a.o || path.basename(f).replace(/\.\w+(\.gz)?$/, '') + (m ? '_' + m.level.replace(/\s/g, '-').toLowerCase() : '') + '_courier.tar.gz';
    const b = await Share.buildBundle({ name: path.basename(f), format: fmt, data: { file: src, delimiter: src === cleaned ? ',' : d.delimiter }, card: Share.markCard(card, m ? markingText(m) : null), ledgerFile: steps.length ? ledger : null, license: a.license,
      attest: { name: cname, org: corg.join(', '), rights: true }, gate, steps, rows: d.rows, columns: d.columns.length, source: { name: path.basename(f), bytes: fs.statSync(f).size, sha256: await Provenance.sha256File(f), hash_of: 'the source file' },
      keys: k, engine: Provenance.engineInfo(path.join(__dirname, '..')), signer: { user: ctx.user, tool: `bulwark ${VERSION}` }, marking: m ? markingText(m) : null, twoPerson: !!a.twoPerson }, o, progress('Packing'));
    endProgress(); if (m) setMarking(o, m);
    out(`\n${green('✓')} Packed ${b.files.length} files → ${bold(o)} · signed with key ${k.keyId}${a.twoPerson ? `\n  ${yellow('Two-person release:')} a second person must run  bulwark courier approve ${o} --as <name>` : ''}`);
    cairn(ctx.user, 'courier.pack', o, `${path.basename(f)} · ${d.rows} rows · ${a.license}${a.twoPerson ? ' · two-person' : ''}`);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

cmd('purge', 'purge <file> [--yes]', 'Destroy a file: overwrite with random data, delete, and write a signed destruction record.', async (a, ctx) => {
  const f = need(a._[0]);
  if (!a.yes) { const ok = await ask(`Destroy ${path.resolve(f)} (${n0(fs.statSync(f).size)} bytes)? This cannot be undone. Type the file name to confirm: `); if (ok.trim() !== path.basename(f)) throw new Fail('Not destroyed.'); }
  const size = fs.statSync(f).size, before = await Provenance.sha256File(f), m = markingOf(f), fd = fs.openSync(f, 'r+'), buf = Buffer.alloc(1 << 20);
  for (let p = 0; p < size; p += buf.length) { crypto.randomFillSync(buf); fs.writeSync(fd, buf, 0, Math.min(buf.length, size - p), p); }
  fs.fsyncSync(fd); fs.closeSync(fd); fs.unlinkSync(f);
  const k = keysFor(ctx.user), rec = Provenance.sign({ kind: 'destruction-record', file: path.resolve(f), bytes: size, sha256_before: before, ...(m ? { marking: markingText(m) } : {}), method: 'overwritten once with random data, flushed to disk, then deleted', note: 'On SSDs and APFS the drive may keep old copies of blocks; for full assurance keep data on FileVault-encrypted volumes and destroy the key.', by: ctx.user, at: new Date().toISOString() }, k);
  const o = path.join(HOME, 'destruction', `${path.basename(f)}.${Date.now()}.json`); writeJSON(o, rec);
  out(`${green('✓')} Destroyed ${path.basename(f)} (${n0(size)} bytes). Signed record: ${o}`); cairn(ctx.user, 'purge', path.resolve(f), `sha256 before ${before}`);
});

cmd('depot', 'depot login --server URL --email E | depot list | depot publish <bundle> --title T [--summary S] | depot request <id> --purpose P | depot requests | depot approve <request-id> | depot deny <request-id> | depot fetch <id> -o file', 'Data Commons on a QuantETL server: list datasets, request access, release approved bundles (Depot).', async (a, ctx) => {
  const sess = path.join(HOME, 'depot.json'), s = readJSON(sess, {}), [action, x] = a._;
  const api = async (method, p, body, raw) => {
    if (!s.server) throw new Fail('Log in first: bulwark depot login --server http://host:8080 --email you@org');
    const res = await fetch(s.server + '/api' + p, { method, headers: { 'X-QuantETL': '1', cookie: s.cookie || '', ...(body && !raw ? { 'Content-Type': 'application/json' } : {}), ...(raw ? { 'Content-Type': 'application/octet-stream' } : {}) }, body: raw || (body ? JSON.stringify(body) : undefined) });
    if (!res.ok) { const j = await res.json().catch(() => ({})); throw new Fail(j.error || `Server answered ${res.status}.`); }
    return res;
  };
  if (action === 'login') {
    const server = String(a.server || '').replace(/\/$/, ''); if (!/^https?:\/\//.test(server)) throw new Fail('Give --server http://host:port');
    const email = a.email || await ask('Email: '), password = await ask('Password: ', true);
    const res = await fetch(server + '/api/auth/signin', { method: 'POST', headers: { 'X-QuantETL': '1', 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password, remember: true }) });
    const j = await res.json().catch(() => ({})); if (!res.ok) throw new Fail(j.error || 'Sign-in failed.');
    if (j.ticket) throw new Fail('This account uses two-factor sign-in; sign in on the console instead.');
    const cookie = (res.headers.get('set-cookie') || '').split(';')[0]; writeJSON(sess, { server, cookie, email }); out(`${green('✓')} Signed in to ${server} as ${email}`); return;
  }
  if (action === 'list') { const l = await (await api('GET', '/depot')).json(); section(`Depot · ${s.server}`); out(table(l.listings.map(d => [d.id, d.marking || dim('—'), d.title, n0(d.rows), d.license, d.owner_name || '', d.mine ? 'yours' : d.access || '']), ['id', 'marking', 'title', 'rows', 'license', 'owner', 'access'])); return; }
  if (action === 'publish') { const f = need(x, 'a courier bundle'); const c = await Share.checkBundle(f); if (!c.ok) throw new Fail('The bundle does not verify; fix it before publishing.'); const res = await api('POST', `/depot/upload?title=${encodeURIComponent(a.title || c.manifest.dataset.name)}&summary=${encodeURIComponent(a.summary || '')}`, null, fs.readFileSync(f)); const j = await res.json(); out(`${green('✓')} Listed as ${j.id}: ${j.title}`); cairn(ctx.user, 'depot.publish', j.id, f); return; }
  if (action === 'request') { if (!a.purpose) throw new Fail('Say why you need it: --purpose "…"'); const j = await (await api('POST', `/depot/${encodeURIComponent(x)}/requests`, { purpose: a.purpose, org: a.org || '' })).json(); out(`${green('✓')} Request ${j.id} sent. The owner decides; check with: bulwark depot requests`); return; }
  if (action === 'requests') { const j = await (await api('GET', '/depot/requests')).json(); section('Requests to you'); out(table(j.incoming.map(r => [r.id, r.listing_title, r.requester_name, r.org, r.purpose, r.status]), ['id', 'dataset', 'from', 'org', 'purpose', 'status'])); section('Your requests'); out(table(j.outgoing.map(r => [r.id, r.listing_title, r.status, r.listing]), ['id', 'dataset', 'status', 'listing'])); return; }
  if (action === 'approve' || action === 'deny') { await api('POST', `/depot/requests/${encodeURIComponent(x)}/decision`, { decision: action === 'approve' ? 'approved' : 'denied' }); out(`${green('✓')} Request ${x} ${action === 'approve' ? 'approved' : 'denied'}.`); cairn(ctx.user, 'depot.' + action, x); return; }
  if (action === 'fetch') { const o = a.o || `${x}.tar.gz`; const res = await api('GET', `/depot/${encodeURIComponent(x)}/bundle`); fs.writeFileSync(o, Buffer.from(await res.arrayBuffer())); const c = await Share.checkBundle(o); out(`${c.ok ? green('✓') : red('✗')} Saved ${o} · ${c.ok ? 'verified' : 'DOES NOT VERIFY'}`); cairn(ctx.user, 'depot.fetch', x, o); return; }
  throw new Fail('Use: depot login | list | publish | request | requests | approve | deny | fetch');
});

cmd('logo', 'logo', 'Play the startup animation again (skip it any time with a key; turn it off with --no-splash or BULWARK_NO_SPLASH=1).', async () => {
  if (!(await require('./splash').play({ version: VERSION }))) out(dim('The animation needs an interactive terminal at least 40 columns wide.'));
});

cmd('status', 'status', 'Where Bulwark keeps its keys and record, and what it connects to.', async (a, ctx) => {
  const v = cairnVerify(), k = keysFor(ctx.user), st = readJSON(STATE, {});
  section(`QuantETL Bulwark ${VERSION}`);
  out(`User           ${ctx.user}  ${dim('(change with --as or BULWARK_USER)')}\nSigning key    ${k.keyId}  ${dim(path.join(HOME, 'keys', ctx.user))}\nActivity       ${v.ok ? green('intact') : red('BROKEN')} · ${n0(v.entries)} entries  ${dim(CAIRN)}\nMarkings       ${n0(Object.keys(st.files || {}).length)} files${st.default ? ' · default ' + markingText(st.default) : ''}\nNetwork        ${green('none')} ${dim('— every command runs on this computer; only "depot" talks to a server you name')}\nEngine         etl ${Provenance.engineInfo(path.join(__dirname, '..')).etl_sha256.slice(0, 12)} · Node ${process.version}`);
});
cmd('help', 'help [command]', 'Show commands, or one command\'s usage.', async (a) => {
  const c = a._[0] && CMDS[a._[0]]; if (c) { out(`${bold('bulwark ' + c.name)}  ${c.about}\n\n  ${c.usage.split(' | ').map(u => 'bulwark ' + u).join('\n  ')}`); return; }
  out(`${bold('QuantETL Bulwark')} ${dim(VERSION)} · prepare, prove and move data, entirely on this computer\n`);
  for (const c of Object.values(CMDS)) out(`  ${blue(c.name.padEnd(10))} ${c.about}`);
  out(`\n  ${dim('bulwark help <command> for details · bulwark with no command opens the interactive shell · --as <user> picks the signing identity')}`);
});

/* ---------- interactive shell ---------- */
let rlShared = null;
function ask(q, hidden) {
  return new Promise(res => {
    if (hidden && !process.stdin.isTTY) { // piped input: read one line without echoing it anywhere
      process.stdout.write(q);
      const rl2 = readline.createInterface({ input: process.stdin, terminal: false }); rl2.once('line', (v) => { rl2.close(); process.stdout.write('\n'); res(v); }); return;
    }
    const rl = rlShared || readline.createInterface({ input: process.stdin, output: process.stdout, terminal: !!process.stdin.isTTY });
    if (hidden && process.stdin.isTTY) { const w = rl._writeToOutput; rl._writeToOutput = (s) => { if (s.includes(q)) w.call(rl, s); }; rl.question(q, (v) => { rl._writeToOutput = w; process.stdout.write('\n'); if (!rlShared) rl.close(); res(v); }); }
    else rl.question(q, (v) => { if (!rlShared) rl.close(); res(v); });
  });
}
async function shell(ctx) {
  // The animation runs before the line reader exists, so it never competes with it for the keyboard.
  const played = ctx.noSplash ? false : await require('./splash').play({ version: VERSION });
  const hist = path.join(HOME, 'history'); fs.mkdirSync(HOME, { recursive: true, mode: 0o700 });
  const names = Object.keys(CMDS), ops = Object.keys(QETL.OPS);
  const rl = rlShared = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: !!process.stdin.isTTY, historySize: 500,
    completer: (line) => { const t = tokenize(line), last = /\s$/.test(line) ? '' : (t[t.length - 1] || ''); const pool = t.length <= 1 && !/\s$/.test(line) ? names : t[0] === 'crucible' && t.length >= 4 ? ops : t[0] === 'crucible' ? ['ops', 'new', 'add', 'show', 'remove', 'prepare', 'run'] : t[0] === 'courier' ? ['pack', 'approve', 'verify'] : t[0] === 'veil' ? ['scan', 'protect'] : t[0] === 'cairn' ? ['log', 'verify', 'export'] : t[0] === 'signet' ? ['sign', 'verify', 'key'] : t[0] === 'depot' ? ['login', 'list', 'publish', 'request', 'requests', 'approve', 'deny', 'fetch'] : []; const hits = pool.filter(x => x.startsWith(last)); return [hits.length ? hits : pool, last]; } });
  try { rl.history = fs.readFileSync(hist, 'utf8').split('\n').filter(Boolean).reverse().slice(0, 500); } catch {}
  if (!played && process.stdout.isTTY && !ctx.noSplash) splash();
  banner(maxMarking([readJSON(STATE, {}).default]));
  out(`${bold('QuantETL Bulwark')} ${dim(VERSION)} · ${ctx.user} · key ${keysFor(ctx.user).keyId} · ${dim('offline')}\nType ${blue('help')} for commands, ${blue('exit')} to leave. Tab completes commands and step names.\n`);
  rl.setPrompt(blue('bulwark') + dim(' › ')); rl.prompt();
  for await (const line of rl) {
    const t = tokenize(line.trim());
    if (t.length) {
      if (['exit', 'quit'].includes(t[0])) break;
      fs.appendFileSync(hist, line.trim() + '\n');
      if (!process.stdin.isTTY) out(dim('› ' + line.trim()));
      await exec(t, ctx);
    }
    rl.prompt();
  }
  rl.close(); rlShared = null;
}

async function exec(argv, ctx) {
  const name = argv[0] === 'bulwark' ? argv[1] : argv[0], rest = argv[0] === 'bulwark' ? argv.slice(2) : argv.slice(1);
  const c = CMDS[name];
  if (!c) { out(red(`Unknown command "${name}".`) + ` Type ${blue('help')}.`); return 2; }
  const a = parseArgs(rest);
  const files = a._.filter(x => fs.existsSync(x) && fs.statSync(x).isFile()).concat(a.eval ? [a.eval] : []);
  if (!['mark', 'help', 'status', 'cairn', 'depot'].includes(name)) banner(maxMarking(files.map(markingOf)));
  try { await c.fn(a, { ...ctx, user: a.as ? me(a) : ctx.user }); return 0; }
  catch (e) { endProgress(); out(red('✗ ') + (e instanceof Fail ? e.message : e.message || String(e))); if (!(e instanceof Fail) && process.env.BULWARK_DEBUG) console.error(e); return 1; }
}

async function main(argv) {
  const a = parseArgs(argv), ctx = { user: me(a) };
  if (a.version || argv[0] === 'version') { out(`QuantETL Bulwark ${VERSION}`); return 0; }
  const cmdless = argv.filter(x => !x.startsWith('--') && !(argv[argv.indexOf(x) - 1] === '--as'));
  if (!cmdless.length || argv[0] === 'shell') { await shell({ ...ctx, noSplash: !!a.noSplash }); return 0; }
  return exec(argv.filter((x, i) => !(x === '--as' || argv[i - 1] === '--as')), ctx);
}

module.exports = { main, exec, parseMarking, maxMarking, markingText, cairnVerify, VERSION };
