#!/usr/bin/env node
// Benchmark for the AI-data pipeline on a synthetic JSONL corpus, run the way the server runs large datasets.
//
//   node scripts/bench.js [documents=200000] [--workers N] [--keep]
//
// Generates documents (about 180 words each, with 6% exact and 4% near duplicates, 3% junk and 2% personal data),
// then runs "Prepare for training" (redact, quality, near-duplicates, language, tokens, split) over the file and prints
// throughput and peak memory. Files go to the system temp folder and are deleted unless --keep is given.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const E = require(path.join(__dirname, '..', 'lib', 'bigengine.js'));

const args = process.argv.slice(2), flag = (k) => { const i = args.indexOf(k); return i >= 0 ? args.splice(i, 2)[1] : null; };
const workers = +flag('--workers') || 0, keep = args.includes('--keep');
const N = +(args.find(a => /^\d+$/.test(a)) || 200000);

let seed = 12345; const rnd = () => (seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 4294967296;
const pick = (a) => a[Math.floor(rnd() * a.length)];
const W = 'river bridge harvest orchard library council engineer survey market harbour station museum garden budget report meeting winter summer morning evening bakery ferry tower canal festival volunteer teacher student archive letter window ticket schedule repair measure record inspect restore translate analyse catalogue photograph plant count sort replace rebuild study describe question paint clean redesign test move audit map'.split(' ');
const F = 'the a an of in on at for with by from to and but or as after before during while near under over beside'.split(' ');
function doc() { const s = []; const n = 8 + Math.floor(rnd() * 10); for (let i = 0; i < n; i++) { const w = []; const m = 9 + Math.floor(rnd() * 9); for (let k = 0; k < m; k++) w.push(k % 3 === 1 ? pick(F) : pick(W)); s.push(w.join(' ').replace(/^./, c => c.toUpperCase()) + '.'); } return s.join(' '); }

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qetl-bench-')), file = path.join(dir, 'corpus.jsonl');
  let t0 = Date.now();
  const out = fs.createWriteStream(file, { highWaterMark: 1 << 22 }); const recent = [];
  for (let i = 0; i < N; i++) {
    let text; const r = rnd();
    if (r < 0.06 && recent.length) text = pick(recent);
    else if (r < 0.10 && recent.length) { const w = pick(recent).split(' '); const k = Math.max(2, Math.round(w.length * 0.05)); text = w.concat(doc().split(' ').slice(0, k)).join(' '); }
    else if (r < 0.13) text = 'We use cookies to improve your experience. Accept all cookies. ' + i;
    else { text = doc(); if (r < 0.15) text += ` Contact ${pick(W)}.${i}@example.com or +1 555 ${100 + (i % 900)} ${1000 + (i % 9000)}.`; }
    if (recent.length < 5000) recent.push(text); else recent[i % 5000] = text;
    if (!out.write(JSON.stringify({ id: 'd' + i, text, source: pick(['web', 'books', 'forum']) }) + '\n')) await new Promise(r => out.once('drain', r));
  }
  await new Promise(r => out.end(r));
  const bytes = fs.statSync(file).size;
  console.log(`generated ${N.toLocaleString('en-US')} documents, ${(bytes / 1e6).toFixed(0)} MB in ${((Date.now() - t0) / 1000).toFixed(1)} s`);

  const steps = [{ id: 1, op: 'redact_text', params: { columns: ['text'], style: 'tokens' } }, { id: 2, op: 'text_quality', params: { column: 'text', preset: 'documents' } },
    { id: 3, op: 'near_duplicates', params: { column: 'text' } }, { id: 4, op: 'language', params: { column: 'text' } }, { id: 5, op: 'token_count', params: { column: 'text' } }, { id: 6, op: 'train_test_split', params: { key: 'id' } }];
  let peak = 0; const mem = setInterval(() => { peak = Math.max(peak, process.memoryUsage().rss); }, 200);
  t0 = Date.now(); let lastLog = 0;
  const r = await E.runFile(file, steps, path.join(dir, 'out.csv'), { ledgerFile: path.join(dir, 'ledger.csv'), workers, onProgress: (p) => { const now = Date.now(); if (now - lastLog > 5000) { lastLog = now; console.log(`  ${p.phase} pass ${p.pass}/${p.passes}: ${Number(p.rows || 0).toLocaleString('en-US')} rows, ${((p.bytes || 0) / 1e6).toFixed(0)} of ${((p.totalBytes || 0) / 1e6).toFixed(0)} MB`); } } });
  clearInterval(mem); peak = Math.max(peak, process.memoryUsage().rss);
  const s = (Date.now() - t0) / 1000;
  console.log(`\nran ${steps.length} steps on ${N.toLocaleString('en-US')} documents in ${s.toFixed(1)} s · ${Math.round(N / s).toLocaleString('en-US')} documents/s · ${(bytes / 1e6 / s).toFixed(1)} MB/s · peak memory ${(peak / 1e6).toFixed(0)} MB${workers ? ` · ${workers} workers` : ''}`);
  console.log(`kept ${r.rows.toLocaleString('en-US')} of ${r.rowsIn.toLocaleString('en-US')}: ` + r.results.map((x, i) => `${steps[i].op} ${(x.rowsBefore - x.rowsAfter).toLocaleString('en-US')} removed`).filter(x => !/ 0 removed/.test(x)).join(', '));
  if (keep) console.log('files kept in ' + dir); else fs.rmSync(dir, { recursive: true, force: true });
})().catch(e => { console.error(e); process.exit(1); });
