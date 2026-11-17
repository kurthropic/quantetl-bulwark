/* QuantETL AI Data: training-data readiness report, the "Prepare for training" step bundle, the removal ledger,
   dataset cards and provenance manifests. Pure functions over { columns, rows } tables; js/console.js draws them.
   Everything runs on this machine (in the page, or in a server worker for large datasets). */
(function () {
  const Q = () => (typeof window !== 'undefined' ? window : globalThis).QETL;
  const isNull = (v) => Q().isNull(v);
  const textOf = (v) => (isNull(v) ? '' : typeof v === 'string' ? v : String(v));
  const wordsN = (s) => Q().textLength(s, 'words');
  const yieldNow = () => new Promise(r => setTimeout(r, 0));

  /** The column that most looks like the text to train on: the longest values on average among text columns. */
  function pickTextColumn(t) {
    let best = null, bestLen = 0; const n = Math.min(t.rows.length, 2000);
    t.columns.forEach((c, ci) => {
      let len = 0, k = 0, strs = 0;
      for (let i = 0; i < n; i++) { const v = t.rows[i][ci]; if (isNull(v)) continue; k++; if (typeof v === 'string' && !/^[-+]?\d+([.,]\d+)?$/.test(v.trim()) && !/^[[{]/.test(v)) { strs++; len += v.length; } }
      if (!k || strs < k * 0.8) return;
      const avg = len / k; if (avg > bestLen) { bestLen = avg; best = c; }
    });
    return best;
  }
  const idColumn = (t) => t.columns.find(c => /(^|[_\s.])(id|key|uuid|ticket)$/i.test(c)) || null;
  const QA_PROMPT = /^(question|prompt|query|instruction|input|user|ask|customer_message|request)s?$/i, QA_RESP = /^(answer|response|reply|output|completion|assistant|agent_message|resolution)s?$/i;
  const qaPair = (t) => { const q = t.columns.find(c => QA_PROMPT.test(c.split('.').pop())), a = t.columns.find(c => QA_RESP.test(c.split('.').pop())); return q && a ? { prompt: q, response: a } : null; };

  // Uniform sample of row indices (every k-th row), so a report on a big table stays quick and representative.
  function sampleIdx(n, limit) { if (n <= limit) return Array.from({ length: n }, (_, i) => i); const step = n / limit, out = []; for (let i = 0; i < limit; i++) out.push(Math.floor(i * step)); return out; }

  /**
   * Readiness report for training on column `col`. Runs in slices so the page stays responsive.
   * opts: limit (rows examined, default 10,000), totalRows (the full dataset's row count, for large datasets), onProgress(fraction).
   */
  async function readiness(t, col, opts = {}) {
    const QE = Q(), ci = t.columns.indexOf(col); if (ci < 0) throw new Error(`Column "${col}" not found.`);
    const idx = sampleIdx(t.rows.length, opts.limit || 10000), n = idx.length;
    const lens = [], toks = [];
    const words = [];
    for (const i of idx.slice(0, 400)) words.push(wordsN(textOf(t.rows[i][ci])));
    words.sort((a, b) => a - b);
    const preset = (words[Math.floor(words.length / 2)] || 0) >= 50 ? 'documents' : 'short', th = QE.qualityThresholds({ preset });
    const dup = new QE.NearDupIndex({ threshold: 0.8 });
    const r = { column: col, rows: t.rows.length, totalRows: opts.totalRows || t.rows.length, examined: n, sampled: n < (opts.totalRows || t.rows.length), preset,
      empty: 0, chars: 0, tokens: 0, langs: {}, exact: 0, near: 0, quality: {}, failed: 0, piiDocs: 0, pii: {}, examples: { quality: [], dup: [], pii: [] } };
    let k = 0;
    for (const i of idx) {
      const s = textOf(t.rows[i][ci]);
      if (!s.trim()) { r.empty++; } else {
        const w = wordsN(s), tk = QE.estimateTokens(s); lens.push(w); toks.push(tk); r.chars += s.length; r.tokens += tk;
        const L = QE.detectLanguage(s).lang; r.langs[L] = (r.langs[L] || 0) + 1;
        const d = dup.check(s, i + 1); if (d) { if (d.exact) r.exact++; else r.near++; if (r.examples.dup.length < 5) r.examples.dup.push({ row: i + 1, of: d.row, sim: d.sim, text: s.slice(0, 160) }); }
        const why = QE.qualityIssue(s, th); if (why) { r.failed++; const label = QE.QUALITY_REASONS[why]; r.quality[label] = (r.quality[label] || 0) + 1; if (r.examples.quality.length < 6) r.examples.quality.push({ row: i + 1, why: label, text: s.slice(0, 160) }); }
        const kinds = QE.findTextPII(s); if (kinds.length) { r.piiDocs++; for (const x of kinds) r.pii[x] = (r.pii[x] || 0) + 1; if (r.examples.pii.length < 5) r.examples.pii.push({ row: i + 1, kinds, text: QE.redactText(s.slice(0, 160)) }); }
      }
      if (++k % 400 === 0) { if (opts.onProgress) opts.onProgress(k / n); await yieldNow(); }
    }
    lens.sort((a, b) => a - b); toks.sort((a, b) => a - b);
    const q = (a, p) => (a.length ? a[Math.min(a.length - 1, Math.floor(p * a.length))] : 0);
    r.words = { median: q(lens, 0.5), p05: q(lens, 0.05), p95: q(lens, 0.95), max: lens.length ? lens[lens.length - 1] : 0 };
    r.tokensPerDoc = { median: q(toks, 0.5), p95: q(toks, 0.95), max: toks.length ? toks[toks.length - 1] : 0 };
    const cap = q(lens, 0.99); r.lengthBins = QE.histogram(lens.filter(x => x <= cap), 24).map(b => ({ ...b, lo: Math.ceil(b.x0), hi: Math.floor(b.x1) })); r.lengthCap = cap;
    const scale = r.totalRows / Math.max(1, n);
    r.estTotalTokens = Math.round(r.tokens * scale);
    r.langList = Object.entries(r.langs).sort((a, b) => b[1] - a[1]).map(([code, c]) => ({ code, name: QE.LANGUAGES[code] || code, count: c, share: c / Math.max(1, n - r.empty) }));
    r.qa = qaPair(t); r.idCol = idColumn(t);
    r.score = readinessScore(r);
    if (opts.onProgress) opts.onProgress(1);
    return r;
  }
  // 0–100: share of documents that would survive the recommended bundle, minus a penalty for personal data left in.
  function readinessScore(r) {
    const docs = Math.max(1, r.examined - r.empty);
    const keep = Math.max(0, docs - r.exact - r.near - r.failed) / docs, pii = r.piiDocs / docs;
    return Math.max(0, Math.round(100 * keep - Math.min(30, pii * 300) - (r.empty / Math.max(1, r.examined)) * 20));
  }

  /** Recommended steps for this report, skipping ones the pipeline already has. Each has a plain-English reason. */
  function bundle(r, steps) {
    const has = (op, col) => (steps || []).some(s => !s.disabled && s.op === op && (!col || JSON.stringify(s.params || {}).includes(JSON.stringify(col))));
    const c = r.column, out = [], docs = Math.max(1, r.examined - r.empty), share = (x) => (x / docs * 100).toFixed(1) + '%';
    const add = (op, params, reason, on = true) => { if (!has(op, op === 'train_test_split' || op === 'format_chat' ? null : c)) out.push({ op, params, reason, on }); };
    if (r.piiDocs) add('redact_text', { columns: [c], style: 'tokens' }, `${share(r.piiDocs)} of documents contain personal data (${Object.entries(r.pii).map(([k, n]) => `${n} ${k}`).join(', ')}). Models can memorise and repeat it, so it is replaced with placeholders like <|email|>.`);
    add('text_quality', { column: c, preset: r.preset, action: 'remove' }, r.failed ? `${share(r.failed)} of documents fail quality checks (${Object.entries(r.quality).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, n]) => `${k.toLowerCase()} ${n}`).join(', ')}). Low-quality text lowers model quality per token spent.` : 'No documents failed the quality checks in this sample; the step guards future data.', !!r.failed);
    add('near_duplicates', { column: c, threshold: 0.8, action: 'remove' }, r.exact + r.near ? `${share(r.exact + r.near)} of documents repeat earlier ones (${r.exact} exact, ${r.near} near). Duplicates make a model over-learn them and waste compute.` : 'No duplicates found in this sample; the step guards future data.', !!(r.exact + r.near));
    const top = r.langList[0];
    add('language', { column: c }, r.langList.length > 1 ? `Several languages found (${r.langList.slice(0, 4).map(l => `${l.name} ${(l.share * 100).toFixed(0)}%`).join(', ')}). Adds a lang column so you can filter or balance them${top ? `; set "Keep only" to ${top.code} for a single-language model` : ''}.` : `Labels each document's language (${top ? top.name : 'unknown'}) so the dataset card and filters can use it.`);
    add('token_count', { column: c }, `Adds an estimated token count per document (median ${r.tokensPerDoc.median}, longest ${r.tokensPerDoc.max}) to budget training and spot over-long records.`);
    if (r.qa) add('format_chat', { template: 'messages', prompt: r.qa.prompt, response: r.qa.response }, `${r.qa.prompt} and ${r.qa.response} look like question/answer pairs: this builds one chat record per row, ready for fine-tuning (Export → Training JSONL).`);
    add('train_test_split', { ...(r.idCol ? { key: r.idCol } : {}), train: 80, validation: 10, test: 10 }, `Assigns each row to train, validation or test (80/10/10) by a hash${r.idCol ? ` of ${r.idCol}` : ''}, so a record never moves between splits when the data is re-run.`);
    return out;
  }

  /**
   * Removal ledger: which rows each step removed, and why. Runs the steps on a copy of the table with row identity
   * kept, so every removed row is accounted for. Returns { steps: [{ index, label, describe, removed, reasons, examples }], rows }.
   */
  function ledger(base, steps, textCol) {
    const QE = Q(), t = { columns: [...base.columns], rows: base.rows.map(r => [...r]) }, num = new Map();
    t.rows.forEach((r, i) => num.set(r, i + 1));
    const keyCol = idColumn(base), out = [], rows = [];
    let cur = t, why = null;
    QE.setInPlace(true); QE.setReasonSink((row, reason, detail) => { if (why) why.set(row, [reason, detail]); });
    try {
      steps.forEach((s, index) => {
        if (s.disabled || !QE.OPS[s.op]) return;
        why = new Map(); const before = cur.rows, ti = cur.columns.indexOf(textCol), ki = keyCol ? cur.columns.indexOf(keyCol) : -1;
        const res = QE.runPipeline(cur, [s]); const r = res.results[0];
        if (r.error) { out.push({ index, op: s.op, label: QE.OPS[s.op].label, describe: QE.OPS[s.op].describe(s.params || {}), removed: 0, error: r.error, reasons: [], examples: [] }); return; }
        const after = new Set(res.table.rows), counts = new Map(), examples = [];
        for (const row of before) {
          if (after.has(row)) continue;
          const [reason, detail] = why.get(row) || [`Removed by ${QE.OPS[s.op].label.toLowerCase()}`, ''];
          counts.set(reason, (counts.get(reason) || 0) + 1);
          const rec = { row: num.get(row) || '', key: ki >= 0 ? textOf(row[ki]) : '', step: index + 1, stepLabel: QE.OPS[s.op].label, reason, detail: detail || '', excerpt: ti >= 0 ? textOf(row[ti]).replace(/\s+/g, ' ').slice(0, 160) : '' };
          rows.push(rec); if (examples.length < 5) examples.push(rec);
        }
        out.push({ index, op: s.op, label: QE.OPS[s.op].label, describe: QE.OPS[s.op].describe(s.params || {}), removed: before.length - res.table.rows.length, rowsBefore: before.length, rowsAfter: res.table.rows.length, reasons: [...counts.entries()].sort((a, b) => b[1] - a[1]), examples });
        cur = res.table;
      });
    } finally { QE.setInPlace(false); QE.setReasonSink(null); }
    return { steps: out, rows, keyCol, rowsIn: base.rows.length, rowsOut: cur.rows.length };
  }
  function ledgerCSV(L) {
    const esc = (v) => { const s = String(v ?? ''); return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
    return ['row,' + (L.keyCol ? esc(L.keyCol) + ',' : '') + 'step,step_name,reason,detail,excerpt', ...L.rows.map(r => [r.row, ...(L.keyCol ? [r.key] : []), r.step, r.stepLabel, r.reason, r.detail, r.excerpt].map(esc).join(','))].join('\n') + '\n';
  }

  /** Hugging Face-style dataset card (README.md). info: { name, license, description, report, steps, out, manifest, large }. */
  function datasetCard(info) {
    const QE = Q(), r = info.report, steps = (info.steps || []).filter(s => !s.disabled && QE.OPS[s.op]), out = info.out || {};
    const n = (x) => Number(x || 0).toLocaleString('en-US');
    const langs = r ? r.langList.filter(l => l.code !== 'und').slice(0, 8) : [];
    const splitCounts = out.splits ? Object.entries(out.splits).map(([k, v]) => `| ${k} | ${n(v)} |`).join('\n') : '';
    const yaml = ['---', `license: ${info.license || 'other'}`, ...(langs.length ? ['language:', ...langs.map(l => `  - ${l.code}`)] : []),
      `size_categories:`, `  - ${sizeCat(out.rows ?? r?.totalRows ?? 0)}`, 'tags:', '  - quantetl', ...(steps.some(s => s.op === 'format_chat') ? ['task_categories:', '  - text-generation'] : []), '---'].join('\n');
    const body = [
      `# ${info.title || info.name}`, '',
      info.description || `Prepared with QuantETL from \`${info.name}\`. Every step below ran on the owner's own machine.`, '',
      '## Dataset summary', '',
      `| | |`, `|---|---|`,
      `| Source | \`${info.name}\` (${n(info.rowsIn)} rows) |`,
      `| Output | ${n(out.rows)} rows × ${n(out.cols)} columns |`,
      ...(r ? [`| Text column | \`${r.column}\` |`, `| Estimated tokens | ${n(r.estTotalTokens)} (estimate: about 4 characters per token)${r.sampled ? ', from a sample' : ''} |`, `| Median length | ${n(r.words.median)} words (95th percentile ${n(r.words.p95)}) |`] : []),
      '', ...(langs.length ? ['## Languages', '', '| Language | Share |', '|---|---|', ...langs.map(l => `| ${l.name} (\`${l.code}\`) | ${(l.share * 100).toFixed(1)}% |`), '', 'Detected offline by QuantETL from writing system and common words (estimated).', ''] : []),
      '## How it was prepared', '',
      ...(steps.length ? steps.map((s, i) => `${i + 1}. ${QE.OPS[s.op].describe(s.params || {})}`) : ['No processing steps: this is the source data.']), '',
      ...(info.ledger ? ['### What was removed', '', '| Step | Rows removed | Main reasons |', '|---|---|---|', ...info.ledger.steps.filter(s => s.removed).map(s => `| ${s.index + 1}. ${s.label} | ${n(s.removed)} | ${s.reasons.slice(0, 3).map(([k, c]) => `${k} (${n(c)})`).join('; ')} |`), ''] : []),
      ...(splitCounts ? ['## Splits', '', '| Split | Rows |', '|---|---|', splitCounts, ''] : []),
      '## Personal data', '',
      steps.some(s => s.op === 'redact_text' || s.op === 'mask') ? `Personal data was removed or masked by: ${steps.filter(s => s.op === 'redact_text' || s.op === 'mask').map(s => QE.OPS[s.op].describe(s.params || {})).join('; ')}.` : (r && r.piiDocs ? `**Warning:** ${n(r.piiDocs)} of ${n(r.examined)} examined documents contain personal data (${Object.keys(r.pii).join(', ')}) and no redaction step was applied.` : 'No personal data was found in the examined documents.'), '',
      ...(r ? ['## Quality', '', `${n(r.failed)} of ${n(r.examined)} examined documents failed the ${r.preset === 'short' ? 'short-text' : 'document'} quality checks before processing; ${n(r.exact)} exact and ${n(r.near)} near duplicates were found.`, ''] : []),
      '## Provenance', '',
      info.manifest ? `A signed manifest (\`${(info.name || 'data').replace(/\.\w+(\.gz)?$/, '')}_manifest.json\`) records the source and output SHA-256 hashes, every step and its settings, and an Ed25519 signature (key ID \`${info.manifest.signature.key_id}\`). Check it with \`node scripts/verify-manifest.js\`.` : 'Download the signed manifest from the Export tab to record source and output hashes.', '',
      '## License', '', info.license ? `${info.license}.` : 'Not specified. Set a license before sharing this dataset.', '',
      `_Generated by QuantETL on ${new Date().toISOString().slice(0, 10)}._`, ''];
    return yaml + '\n\n' + body.join('\n');
  }
  function sizeCat(n) { return n < 1e3 ? 'n<1K' : n < 1e4 ? '1K<n<10K' : n < 1e5 ? '10K<n<100K' : n < 1e6 ? '100K<n<1M' : n < 1e7 ? '1M<n<10M' : n < 1e8 ? '10M<n<100M' : 'n>100M'; }

  // SHA-256 of text as UTF-8, with the browser's native digest when available.
  async function sha256Text(s) {
    const c = typeof crypto !== 'undefined' && crypto.subtle;
    if (c) { const buf = await c.digest('SHA-256', new TextEncoder().encode(s)); return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join(''); }
    return Q().sha256(s);
  }
  /** Unsigned manifest for a browser-processed dataset; the server adds the engine hash, time and signature. */
  async function manifestDraft(rec, base, steps, out) {
    const QE = Q(), csvIn = QE.toCSV(base), csvOut = QE.toCSV(out);
    return {
      quantetl_manifest: 1,
      dataset: { id: rec.id, name: rec.name },
      source: { name: rec.name, rows: base.rows.length, columns: base.columns.length, sha256: await sha256Text(csvIn), hash_of: 'the source table written as CSV (QuantETL CSV export format)' },
      steps: steps.filter(s => !s.disabled && QE.OPS[s.op]).map(s => ({ op: s.op, params: s.params || {}, describe: QE.OPS[s.op].describe(s.params || {}) })),
      output: { rows: out.rows.length, columns: out.columns.length, column_names: out.columns, sha256: await sha256Text(csvOut), hash_of: 'the CSV download of the output (Export → CSV)', format: 'csv' },
      hashes_computed: 'in the browser',
    };
  }

  const api = { pickTextColumn, idColumn, qaPair, readiness, readinessScore, bundle, ledger, ledgerCSV, datasetCard, manifestDraft, sha256Text };
  (typeof window !== 'undefined' ? window : globalThis).QAI = api;
})();
