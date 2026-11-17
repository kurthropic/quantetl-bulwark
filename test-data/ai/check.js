// Checks QuantETL's AI-data steps against answer.json. Run from the project folder: node test-data/ai/check.js
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const Q = require(path.join(ROOT, 'lib', 'qetl.js'));
const E = require(path.join(ROOT, 'lib', 'bigengine.js'));
const ans = JSON.parse(fs.readFileSync(path.join(__dirname, 'answer.json'), 'utf8'));
const read = (f) => Q.parseJSONL(fs.readFileSync(path.join(__dirname, f), 'utf8'));
const pct = (x) => (x * 100).toFixed(2) + '%';
let failures = 0;
const check = (name, ok, detail) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' · ' + detail : ''}`); if (!ok) failures++; };

(async () => {
  const corpus = read('corpus.jsonl'), ID = corpus.columns.indexOf('id'), TX = corpus.columns.indexOf('text');
  const idsOf = (t) => new Set(t.rows.map(r => r[t.columns.indexOf('id')]));
  const all = idsOf(corpus), junk = new Set(Object.keys(ans.junk));
  console.log(`corpus: ${corpus.rows.length} documents, columns ${corpus.columns.join(', ')}`);

  // 1. Duplicates
  let t0 = Date.now(); const reasons = new Map();
  Q.setReasonSink((row, why) => reasons.set(row[ID], why));
  const dd = Q.runPipeline(corpus, [{ id: 'd', op: 'near_duplicates', params: { column: 'text' } }]);
  Q.setReasonSink(null);
  const kept = idsOf(dd.table), removed = [...all].filter(id => !kept.has(id)), ms = Date.now() - t0;
  const exactOk = ans.exact_groups.filter(([a, b]) => kept.has(a) !== kept.has(b)).length;
  const exactWhy = ans.exact_groups.filter(([a, b]) => /^Exact/.test(reasons.get(kept.has(a) ? b : a) || '')).length;
  const nearFound = ans.near_groups.filter(([a, b]) => kept.has(a) !== kept.has(b)).length;
  const inGroup = new Set([...ans.exact_groups, ...ans.near_groups].flatMap(g => [g[0], g[1]]));
  const falsePos = removed.filter(id => !inGroup.has(id) && !junk.has(id));
  check('exact duplicates', exactOk === 1200 && exactWhy === 1200, `${exactOk}/1200 pairs reduced to one, ${exactWhy} labelled exact`);
  check('near duplicates: recall ≥ 95%', nearFound / 800 >= 0.95, `${nearFound}/800 (${pct(nearFound / 800)})`);
  const tp = exactOk + nearFound, prec = tp / (tp + falsePos.length);
  check('duplicates: precision ≥ 98%', prec >= 0.98, `${falsePos.length} non-duplicate documents removed (precision ${pct(prec)}); ${removed.filter(id => junk.has(id)).length} repeated junk pages also removed; ${ms} ms`);

  // 2. Quality filter
  t0 = Date.now(); const qwhy = new Map();
  Q.setReasonSink((row, why) => qwhy.set(row[ID], why));
  const qf = Q.runPipeline(corpus, [{ id: 'q', op: 'text_quality', params: { column: 'text', preset: 'documents' } }]);
  Q.setReasonSink(null);
  const qkept = idsOf(qf.table), junkCaught = [...junk].filter(id => !qkept.has(id)).length, cleanLost = [...all].filter(id => !junk.has(id) && !qkept.has(id));
  const byKind = {}; for (const [id, k] of Object.entries(ans.junk)) { byKind[k] = byKind[k] || [0, 0]; byKind[k][1]++; if (!qkept.has(id)) byKind[k][0]++; }
  check('quality filter catches junk', junkCaught === 600, `${junkCaught}/600 · ${Object.entries(byKind).map(([k, [a, b]]) => `${k} ${a}/${b}`).join(', ')}`);
  check('quality filter keeps clean text (≤ 1% lost)', cleanLost.length / (all.size - 600) <= 0.01, `${cleanLost.length} clean documents removed${cleanLost.length ? ': ' + [...new Set(cleanLost.map(id => qwhy.get(id)))].join('; ') : ''}; ${Date.now() - t0} ms`);

  // 3. Language
  t0 = Date.now(); let right = 0, total = 0; const wrong = {};
  for (const r of corpus.rows) {
    const want = ans.languages[r[ID]]; if (!want || Q.textLength(r[TX], 'words') <= 20) continue;
    total++; const got = Q.detectLanguage(r[TX]).lang; if (got === want) right++; else wrong[`${want}→${got}`] = (wrong[`${want}→${got}`] || 0) + 1;
  }
  check('language accuracy ≥ 95% (texts over 20 words)', right / total >= 0.95, `${right}/${total} (${pct(right / total)})${Object.keys(wrong).length ? ' · errors ' + JSON.stringify(wrong) : ''}; ${Date.now() - t0} ms`);

  // 4. Personal data
  const red = Q.runPipeline(corpus, [{ id: 'r', op: 'redact_text', params: { columns: ['text'] } }]).table;
  const byId = new Map(red.rows.map(r => [r[ID], r[TX]]));
  const left = ans.pii.filter(p => byId.get(p.id).includes(p.value));
  const planted = new Set(ans.pii.map(p => p.id)), extra = red.rows.filter(r => !planted.has(r[ID]) && /\[(EMAIL|PHONE|CARD|SSN|IBAN|IP)\]/.test(r[TX]));
  check('every planted personal-data value redacted', left.length === 0, `${400 - left.length}/400${left.length ? ' · left: ' + left.slice(0, 3).map(p => p.kind + ' ' + p.value).join(', ') : ''}`);
  check('no redactions in documents without personal data', extra.length === 0, `${extra.length} documents changed${extra.length ? ': ' + extra.slice(0, 2).map(r => r[TX].match(/.{0,40}\[(EMAIL|PHONE|CARD|SSN|IBAN|IP)\].{0,20}/)[0]).join(' | ') : ''}`);

  // 5. Contamination
  const ev = read('eval.jsonl'), EQ = ev.columns.indexOf('question'), EID = ev.columns.indexOf('id');
  t0 = Date.now(); const c = Q.contamination(corpus.rows.map(r => r[TX]), ev.rows.map(r => r[EQ]));
  const found = new Set(c.rows.map(x => ev.rows[x.index][EID])), want = new Set(ans.contaminated.map(x => x.id));
  const miss = [...want].filter(id => !found.has(id)), fp = [...found].filter(id => !want.has(id));
  check('contamination: all 150 found, none extra', miss.length === 0 && fp.length === 0, `${want.size - miss.length}/150 found, ${fp.length} false alarms, ${c.exact} exact copies; ${Date.now() - t0} ms`);

  // 6. Fine-tuning records
  const chats = read('support_chats.jsonl');
  const fc = Q.runPipeline(chats, [{ id: 'f', op: 'format_chat', params: { template: 'messages', prompt: 'question', response: 'answer', system: 'You are a helpful support agent.' } }]);
  const recs = Q.toJSONL(fc.table, { only: 'training_record' }).trim().split('\n');
  const okShape = recs.every(l => { const o = JSON.parse(l); return o.messages.length === 3 && o.messages[0].role === 'system' && o.messages[2].role === 'assistant' && o.messages[2].content; });
  check('fine-tuning records', recs.length === 2000 - ans.summary.chats_without_answer && okShape, `${recs.length} records (${ans.summary.chats_without_answer} chats without an answer skipped)`);

  // 7. Same result in the browser and in a chunked server run
  const steps = [{ id: 1, op: 'redact_text', params: { columns: ['text'] } }, { id: 2, op: 'text_quality', params: { column: 'text', preset: 'documents' } }, { id: 3, op: 'language', params: { column: 'text' } },
    { id: 4, op: 'near_duplicates', params: { column: 'text' } }, { id: 5, op: 'length_filter', params: { column: 'text', unit: 'words', min: 20, max: 5000 } }, { id: 6, op: 'token_count', params: { column: 'text' } },
    { id: 7, op: 'train_test_split', params: { key: 'id' } }];
  const browser = Q.runPipeline(corpus, steps);
  const tmp = fs.mkdtempSync(path.join(require('os').tmpdir(), 'qetl-ai-'));
  t0 = Date.now(); const server = await E.runFile(path.join(__dirname, 'corpus.jsonl'), steps, path.join(tmp, 'out.csv'), { batch: 3000 });
  const same = fs.readFileSync(path.join(tmp, 'out.csv'), 'utf8') === Q.toCSV(browser.table);
  check('browser and chunked server run give identical output', same, `${browser.table.rows.length} rows kept of ${corpus.rows.length}; server ${Date.now() - t0} ms in chunks of 3,000`);
  const sp = {}; for (const r of browser.table.rows) sp[r[r.length - 1]] = (sp[r[r.length - 1]] || 0) + 1;
  console.log('      steps:', browser.results.map((r, i) => `${steps[i].op} ${r.affected}`).join(' · '), '· split', JSON.stringify(sp));
  fs.rmSync(tmp, { recursive: true, force: true });

  console.log(failures ? `\n${failures} check(s) failed.` : '\nAll checks passed.');
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
