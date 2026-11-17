// One slice of a large file, run in its own thread: reads a byte range of a JSONL file (or a range of Parquet row
// groups), applies the pipeline's leading row-by-row steps (redaction, quality, language, …) and writes the result as
// chunks for the main run to continue from. Several of these run at once, one per CPU core (see runFile in
// lib/bigengine.js). Row-by-row steps don't depend on other rows, so the slices give exactly the rows one pass would.
'use strict';
const fs = require('fs');
const v8 = require('v8');
const { parentPort, workerData: d } = require('worker_threads');
const QETL = require('./qetl');
const { readJSONL } = require('./jsonlstream');
const { readParquet } = require('./parquet');

const esc = (v) => { if (v === null || v === undefined) return ''; const s = String(v); return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
const excerpt = (row) => { let best = ''; for (const x of row) if (typeof x === 'string' && x.length > best.length) best = x; return best.replace(/\s+/g, ' ').slice(0, 120); };

(async () => {
  const out = fs.createWriteStream(d.out, { highWaterMark: 1 << 22 }), led = d.ledger ? fs.createWriteStream(d.ledger, { highWaterMark: 1 << 20 }) : null;
  const write = async (s, x) => { if (!s.write(x)) await new Promise(r => s.once('drain', r)); };
  const stats = d.steps.map(() => ({ affected: 0, rowsBefore: 0, rowsAfter: 0, reasons: new Map() }));
  let stepNow = -1, ledBuf = '', rowsIn = 0, bytes = 0, last = 0;
  QETL.setInPlace(true);
  QETL.setReasonSink((row, why, detail) => {
    const m = stats[stepNow].reasons; m.set(why, (m.get(why) || 0) + 1);
    if (led) ledBuf += [d.stepNo[stepNow], d.labels[stepNow], why, detail || '', row[0] === undefined ? '' : row[0], excerpt(row)].map(esc).join(',') + '\n';
  });
  try {
    const src = d.format === 'parquet' ? readParquet(d.file, { batch: d.batch, groups: d.groups, onBytes: (b) => { bytes = b; } })
      : readJSONL(d.file, { batch: d.batch, columns: d.columns, start: d.start, end: d.end, onBytes: (b) => { bytes = b; } });
    for await (const b of src) {
      let t = { columns: b.columns, rows: b.rows }; rowsIn += b.rows.length;
      for (let k = 0; k < d.steps.length; k++) {
        const s = d.steps[k], op = QETL.OPS[s.op], before = t.rows.length; stepNow = k;
        let r; try { r = op.apply(t, s.params || {}); } catch (e) { throw new Error(`Step ${d.stepNo[k]} (${op.label}) failed: ${e.message}`); }
        t = r.table; const st = stats[k];
        st.affected = op.affectedOnce ? r.affected : st.affected + r.affected; st.rowsBefore += before; st.rowsAfter += t.rows.length;
      }
      stepNow = -1;
      const body = v8.serialize(t), head = Buffer.alloc(4); head.writeUInt32LE(body.length);
      await write(out, head); await write(out, body);
      if (led && ledBuf) { const x = ledBuf; ledBuf = ''; await write(led, x); }
      const now = Date.now(); if (now - last > 300) { last = now; parentPort.postMessage({ progress: { rows: rowsIn, bytes } }); }
    }
    await new Promise((res, rej) => { out.on('error', rej); out.end(res); });
    if (led) await new Promise((res, rej) => { led.on('error', rej); led.end(res); });
    parentPort.postMessage({ done: { rowsIn, bytes, stats: stats.map(s => ({ ...s, reasons: [...s.reasons.entries()] })) } });
  } catch (e) { parentPort.postMessage({ error: e && e.message ? e.message : String(e) }); }
})();
