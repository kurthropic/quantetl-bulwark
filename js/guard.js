/* QuantETL Guard: the privacy scan and data contracts with drift checks.
   Everything runs on the user's machine against a table and its QETL profile; nothing here sends data anywhere.
   - scanPrivacy(table, prof): finds personal data column by column (validated where a check digit exists), personal
     data inside free text, and how many rows can be singled out from quasi-identifiers (k-anonymity).
   - buildContract(...) / checkContract(...): turn a dataset into rules with thresholds tuned from its own data, then
     check any later dataset against them, with distribution drift measured as PSI. */
(function () {
  const Q = () => window.QETL;
  const isNull = (v) => Q().isNull(v);
  const round = (x, d = 4) => Math.round(x * 10 ** d) / 10 ** d;
  const pctTxt = (x, d = 1) => (x * 100).toFixed(d) + '%';
  const fmt = (x) => (x === null || x === undefined || Number.isNaN(x) ? '—' : Math.abs(x) >= 1e6 || (Math.abs(x) < 0.01 && x !== 0) ? Number(x).toPrecision(3) : Number(round(x, 2)).toLocaleString('en-US'));

  // Evenly spaced rows (deterministic, so the same table always gives the same scan).
  function sampleRows(rows, n) { if (rows.length <= n) return rows; const step = rows.length / n, out = []; for (let i = 0; i < n; i++) out.push(rows[Math.floor(i * step)]); return out; }

  /* ================= Privacy scan ================= */
  const norm = (name) => ' ' + String(name).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim() + ' ';
  // [kind, name pattern]; matched against the column name with separators turned into spaces.
  const HINTS = [
    ['secret', / (password|passwd|pwd|secret|api key|apikey|access token|auth token|private key|token) /],
    ['email', / (e ?mail|email address) /],
    ['phone', / (phone|mobile|cell|tel|telephone|fax|whatsapp) /],
    ['card', / (card|card number|cc|cc number|credit card|pan) /],
    ['iban', / (iban|bank account|account number|acct no|bic) /],
    ['ssn', / (ssn|social security|national id|nin|ni number|national insurance|tax id|tin|passport|driver s? licen[cs]e|licen[cs]e number) /],
    ['dob', / (dob|date of birth|birth ?date|birthday|born) /],
    ['name', / ((first|last|full|middle|given|family|sur|customer|client|patient|employee|contact|holder|cardholder|person|user) ?name|surname|forename|name) /],
    ['address', / (address|street|addr|address line ?\d?|house number|line ?1) /],
    ['zip', / (zip|zip code|zipcode|post ?code|postal|postal code) /],
    ['ip', / (ip|ip address|ipv4|ipv6|client ip|remote addr) /],
    ['geo', / (lat|lng|lon|long|latitude|longitude|geo|coordinates|gps) /],
    ['age', / (age|age years|years old) /],
    ['gender', / (gender|sex) /],
    ['city', / (city|town|municipality) /],
    ['person_id', / ((customer|client|user|patient|member|employee|account|subscriber|student|person|contact) ?(id|no|number|ref)|uid|user) /],
    ['health', / (diagnos[ie]s|medical|health|disease|condition|medication|prescription|allerg[a-z]*|blood type|disability|religion|ethnic(ity)?|race|sexual orientation|political|union member(ship)?|biometric|genetic) /],
    ['income', / (salary|income|wage|net worth|credit score) /],
  ];
  // Names that look personal but aren't (product name, company name...).
  const NOT_PERSON = / (product|company|file|item|brand|city|country|street|host|column|table|sku|category|plan|desk|org|organi[sz]ation|business|vendor|merchant|store|shop|campaign|event|project|team|dept|department|region|ticker|instrument|bank|branch) name /;

  const KIND = {
    email: { label: 'Email address', cat: 'direct', regs: ['GDPR', 'CCPA', 'HIPAA'], fix: { method: 'hash' }, why: 'Pseudonymized: each address becomes a stable token, so you can still count and join customers.' },
    phone: { label: 'Phone number', cat: 'direct', regs: ['GDPR', 'CCPA', 'HIPAA'], fix: { method: 'partial', keep: 2 }, why: 'Partially hidden: only the last 2 digits stay.' },
    card: { label: 'Payment card number', cat: 'direct', regs: ['PCI DSS', 'GDPR', 'CCPA'], fix: { method: 'partial', keep: 4 }, why: 'PCI DSS allows at most the last 4 digits to be shown.' },
    iban: { label: 'Bank account (IBAN)', cat: 'direct', regs: ['GDPR', 'CCPA'], fix: { method: 'partial', keep: 4 }, why: 'Partially hidden: the last 4 characters stay for reconciliation.' },
    ssn: { label: 'Government ID (e.g. SSN)', cat: 'direct', regs: ['GDPR', 'CCPA', 'HIPAA'], fix: { method: 'redact' }, why: 'Government IDs are rarely needed for analysis; redacted.' },
    ni: { label: 'National Insurance number', cat: 'direct', regs: ['GDPR'], fix: { method: 'redact' }, why: 'Government IDs are rarely needed for analysis; redacted.' },
    secret: { label: 'Password or secret', cat: 'direct', regs: ['Security'], fix: { method: 'null' }, why: 'Secrets should never be in an analysis file; removed.' },
    name: { label: 'Person name', cat: 'direct', regs: ['GDPR', 'CCPA', 'HIPAA'], fix: { method: 'hash' }, why: 'Pseudonymized: names become stable tokens, so distinct counts still work.' },
    address: { label: 'Street address', cat: 'direct', regs: ['GDPR', 'CCPA', 'HIPAA'], fix: { method: 'redact' }, why: 'Street addresses identify a household; redacted.' },
    ip: { label: 'IP address', cat: 'direct', regs: ['GDPR', 'CCPA', 'HIPAA'], fix: { method: 'hash' }, why: 'Pseudonymized: sessions from the same address still group together.' },
    person_id: { label: 'Person identifier', cat: 'direct', regs: ['GDPR', 'CCPA', 'HIPAA'], fix: { method: 'hash' }, why: 'Pseudonymized: the ID can no longer be looked up in your source system, but joins still work.' },
    dob: { label: 'Date of birth', cat: 'quasi', regs: ['GDPR', 'CCPA', 'HIPAA'], fix: { method: 'generalize', as: 'year' }, why: 'Generalized to the year of birth (HIPAA Safe Harbor keeps only the year).' },
    age: { label: 'Age', cat: 'quasi', regs: ['GDPR', 'HIPAA'], fix: { method: 'generalize', as: 'band', bucket: 10 }, why: 'Generalized to 10-year bands.' },
    zip: { label: 'ZIP or postcode', cat: 'quasi', regs: ['GDPR', 'CCPA', 'HIPAA'], fix: { method: 'generalize', as: 'prefix', keep: 3 }, why: 'Generalized to the first 3 characters (HIPAA Safe Harbor uses 3-digit ZIPs).' },
    gender: { label: 'Gender', cat: 'quasi', regs: ['GDPR'], fix: null, why: 'Usually needed for analysis. It counts toward re-identification risk below.' },
    city: { label: 'City', cat: 'quasi', regs: ['GDPR'], fix: null, why: 'Usually needed for analysis. It counts toward re-identification risk below.' },
    geo: { label: 'Precise location', cat: 'quasi', regs: ['GDPR', 'CCPA', 'HIPAA'], fix: { op: 'round', decimals: 2 }, why: 'Rounded to 2 decimals (about 1 km), enough for regional analysis.' },
    health: { label: 'Special-category data', cat: 'sensitive', regs: ['GDPR Art. 9', 'HIPAA'], fix: null, why: 'Health, religion, ethnicity and similar data need a legal basis and extra safeguards. Review who can see it.' },
    income: { label: 'Financial detail', cat: 'sensitive', regs: ['GDPR', 'CCPA'], fix: null, why: 'Financial details about a person are sensitive when combined with identifiers.' },
    text: { label: 'Personal data inside text', cat: 'embedded', regs: ['GDPR', 'CCPA'], fix: { method: 'text' }, why: 'Emails, phone numbers, cards, IBANs and IPs inside the text are replaced with [EMAIL], [PHONE] and so on; the rest of the text stays.' },
  };
  const CAT_LABEL = { direct: 'Direct identifier', quasi: 'Quasi-identifier', sensitive: 'Sensitive', embedded: 'In free text' };
  const VALUE_KINDS = ['email', 'card', 'iban', 'ssn', 'ni', 'ipv4', 'ipv6', 'phone'];
  const PERSON_NAME = /^[A-ZÀ-Þ][a-zà-ÿ'’.-]+(?:[ -][A-ZÀ-Þ][a-zà-ÿ'’.-]+){1,3}$/;
  const PROTECTED = /^tok_[0-9a-f]{16}$|^\[REDACTED\]$|\*{2,}|^\[(EMAIL|PHONE|CARD|SSN|IBAN|IP)\]$/;
  const STREET = /^\d+[a-z]?\s+\S+.*\b(st|street|rd|road|ave|avenue|blvd|lane|ln|dr|drive|way|ct|court|pl|place|terrace|close|sq|square|hwy|strasse|straße|rue|via|calle)\b/i;

  function hintOf(name) {
    const n = norm(name), hits = [];
    for (const [kind, re] of HINTS) if (re.test(n)) hits.push(kind);
    if (hits.includes('name') && NOT_PERSON.test(n)) hits.splice(hits.indexOf('name'), 1);
    if (hits.includes('ip') && hits.includes('address')) hits.splice(hits.indexOf('address'), 1); // "ip_address"
    if (hits.includes('email') && hits.includes('address')) hits.splice(hits.indexOf('address'), 1); // "email_address"
    return hits;
  }

  // Masked example for display: never show a raw personal value in the scan itself.
  function maskedExample(kind, v) {
    const s = String(v).trim(), q = Q();
    if (['dob', 'age', 'zip', 'geo'].includes(kind)) return kind === 'geo' ? String(Math.round(+s * 10) / 10) + '…' : q.generalize(s, 10, kind === 'dob' ? 'year' : kind === 'zip' ? 'prefix' : 'band', 3);
    if (kind === 'name') return s.split(/\s+/).map(w => w[0] + '.').join(' ');
    if (kind === 'text') return q.redactTextPII(s).slice(0, 60) + (s.length > 60 ? '…' : '');
    if (kind === 'gender' || kind === 'city') return s.slice(0, 24);
    return q.partialMask(s, 2);
  }

  function classifyColumn(table, ci, colProf, rows) {
    const q = Q(), name = table.columns[ci], hints = hintOf(name);
    const vals = []; for (const r of rows) { const v = r[ci]; if (!isNull(v)) vals.push(String(v).trim()); if (vals.length >= 4000) break; }
    if (!vals.length) return null;
    // values already masked by a Protect step (tokens, [REDACTED], ****) count as protected, not as personal data
    const protectedRate = vals.filter(s => PROTECTED.test(s)).length / vals.length;
    if (protectedRate >= 0.9) return { column: name, index: ci, protected: true };
    // dates and decimal numbers can't be contact details or IDs; integer columns can only be card numbers
    const numericCol = (colProf.type === 'number' || colProf.type === 'integer') && !colProf.textNumeric;
    const kinds = colProf.type === 'date' || colProf.type === 'boolean' ? [] : numericCol ? (colProf.type === 'integer' ? ['card'] : []) : VALUE_KINDS;
    const hit = Object.fromEntries(VALUE_KINDS.map(k => [k, 0]));
    for (const s of vals) for (const k of kinds) if (q.PII[k](s)) { hit[k]++; break; }
    const rate = (k) => hit[k] / vals.length;
    let kind = null, conf = 'medium', matched = 0;
    // 1. values that prove themselves (validated formats)
    const best = VALUE_KINDS.map(k => [k, rate(k)]).sort((a, b) => b[1] - a[1])[0];
    if (best[1] >= 0.6 || (best[1] >= 0.3 && hints.some(h => h === best[0] || (h === 'ip' && best[0].startsWith('ip')) || (h === 'ssn' && best[0] === 'ni')))) {
      kind = best[0].startsWith('ip') ? 'ip' : best[0]; matched = best[1];
      conf = ['card', 'iban', 'ssn', 'email', 'ni', 'ipv4'].includes(best[0]) || hints.includes(kind) ? 'high' : 'medium';
      if (kind === 'phone' && !hints.includes('phone') && best[1] < 0.9) conf = 'low';
    }
    // 2. names, streets, dates of birth and the rest come from the column name, confirmed by the values where possible
    if (!kind) {
      const type = colProf.type, nameRate = vals.filter(s => PERSON_NAME.test(s)).length / vals.length, streetRate = vals.filter(s => STREET.test(s)).length / vals.length;
      for (const h of hints) {
        if (h === 'name') { if (type === 'string' && (nameRate >= 0.5 || colProf.uniquePct > 0.3)) { kind = 'name'; matched = nameRate; conf = nameRate >= 0.6 ? 'high' : 'medium'; break; } continue; }
        if (h === 'address') { if (type === 'string') { kind = 'address'; matched = streetRate; conf = streetRate >= 0.5 ? 'high' : 'medium'; break; } continue; }
        if (h === 'dob') { if (type === 'date' || type === 'string') { kind = 'dob'; matched = 1; conf = type === 'date' ? 'high' : 'medium'; break; } continue; }
        if (h === 'age') { if (['number', 'integer'].includes(type) && colProf.stats && colProf.stats.median >= 0 && colProf.stats.median <= 120) { kind = 'age'; matched = 1; conf = 'high'; break; } continue; }
        if (h === 'zip') { kind = 'zip'; matched = 1; conf = 'high'; break; }
        if (h === 'geo') { if (['number', 'integer'].includes(type) && colProf.stats && Math.abs(colProf.stats.median) <= 180) { kind = 'geo'; matched = 1; conf = 'high'; break; } continue; }
        if (h === 'gender') { if (colProf.unique <= 12) { kind = 'gender'; matched = 1; conf = 'high'; break; } continue; }
        if (h === 'city') { if (type === 'string') { kind = 'city'; matched = 1; conf = 'medium'; break; } continue; }
        if (h === 'person_id') { if (colProf.uniquePct > 0.2 || colProf.unique > 50) { kind = 'person_id'; matched = 1; conf = 'medium'; break; } continue; }
        if (h === 'secret' || h === 'health' || h === 'income' || h === 'card' || h === 'iban' || h === 'ssn' || h === 'email' || h === 'phone' || h === 'ip') {
          if (['card', 'iban', 'ssn', 'email', 'phone', 'ip'].includes(h) && !(colProf.uniquePct > 0.2)) continue; // e.g. "card_type", "email_opt_in"
          if (h === 'card' && colProf.type !== 'string' && colProf.type !== 'integer') continue;
          kind = h; matched = 0; conf = 'low'; break;
        }
      }
      if (!kind && streetRate >= 0.6) { kind = 'address'; matched = streetRate; conf = 'medium'; }
      if (!kind && type === 'string' && nameRate >= 0.8 && colProf.uniquePct > 0.5 && vals.length >= 20) { kind = 'name'; matched = nameRate; conf = 'medium'; }
    }
    // 3. free text: look for personal data inside each value
    let embedded = null;
    if (!kind && colProf.type === 'string' && colProf.len && colProf.len.mean >= 18) {
      let n = 0; const kinds = new Map(), ex = [];
      for (const r of rows) { const v = r[ci]; if (isNull(v)) continue; const f = q.findTextPII(String(v)); if (f.length) { n++; f.forEach(k => kinds.set(k, (kinds.get(k) || 0) + 1)); if (ex.length < 2) ex.push(String(v)); } }
      if (n) { kind = 'text'; matched = n / Math.max(1, colProf.count - colProf.nulls); conf = 'high'; embedded = { rows: n, kinds: [...kinds.entries()].sort((a, b) => b[1] - a[1]).map(([k, c]) => ({ kind: k, rows: c })), examples: ex }; }
    }
    if (!kind) return null;
    const meta = KIND[kind], nonNull = colProf.count - colProf.nulls;
    const examples = (embedded ? embedded.examples : vals.filter((s, i) => i % Math.max(1, Math.floor(vals.length / 7)) === 0).slice(0, 3)).map(v => maskedExample(kind, v));
    return { column: name, index: ci, kind, label: meta.label, category: meta.cat, categoryLabel: CAT_LABEL[meta.cat], confidence: conf, matchRate: matched, rows: embedded ? Math.round(embedded.rows * (rows.length ? (colProf.count / rows.length) : 1)) : nonNull, embedded, examples, regs: meta.regs, why: meta.why, fix: meta.fix };
  }

  // Share of rows that are the only one with their combination of quasi-identifiers (k = 1), and the share in
  // groups smaller than 5. Latanya Sweeney showed ZIP + birth date + gender alone single out about 87% of Americans.
  function reidentification(table, rows, qis) {
    if (!qis.length || !rows.length) return null;
    const idx = qis.map(f => f.index), keyOf = (r) => idx.map((ci, j) => { const v = r[ci]; if (isNull(v)) return '∅'; return qis[j].kind === 'geo' ? String(Math.round(+v * 1000) / 1000) : String(v).trim().toLowerCase(); }).join('\u0001');
    const groups = new Map(); for (const r of rows) { const k = keyOf(r); groups.set(k, (groups.get(k) || 0) + 1); }
    let unique = 0, small = 0, kMin = Infinity; for (const c of groups.values()) { if (c === 1) unique++; if (c < 5) small += c; if (c < kMin) kMin = c; }
    return { columns: qis.map(f => f.column), rows: rows.length, groups: groups.size, unique, uniquePct: unique / rows.length, smallPct: small / rows.length, k: kMin === Infinity ? 0 : kMin };
  }

  function scanPrivacy(table, prof, opts = {}) {
    const rows = sampleRows(table.rows, opts.maxRows || 100000), sampled = rows.length < table.rows.length;
    const findings = [];
    const protectedCols = [];
    table.columns.forEach((_, ci) => { const f = classifyColumn(table, ci, prof.columns[ci], rows); if (f && f.protected) protectedCols.push(f.column); else if (f) findings.push(f); });
    // the quasi-identifiers an attacker would combine; precise location alone is close to an identifier
    const qis = findings.filter(f => f.category === 'quasi').sort((a, b) => ['zip', 'dob', 'geo', 'age', 'gender', 'city'].indexOf(a.kind) - ['zip', 'dob', 'geo', 'age', 'gender', 'city'].indexOf(b.kind)).slice(0, 4);
    const reid = reidentification(table, rows, qis);
    const weight = { secret: 30, card: 25, ssn: 25, ni: 25, iban: 22, address: 12, name: 12, email: 12, phone: 12, person_id: 6, ip: 8, text: 10, health: 15, income: 6 };
    let risk = 0; for (const f of findings) risk += f.category === 'quasi' ? 0 : (weight[f.kind] || 5) * (f.confidence === 'low' ? 0.5 : 1);
    if (reid) risk += reid.uniquePct * 35 + (reid.smallPct - reid.uniquePct) * 10;
    risk = Math.min(100, Math.round(risk));
    const level = risk >= 60 ? 'high' : risk >= 30 ? 'medium' : risk > 0 ? 'low' : 'none';
    const counts = { direct: 0, quasi: 0, sensitive: 0, embedded: 0 }; findings.forEach(f => counts[f.category]++);
    const regs = [...new Set(findings.flatMap(f => f.regs))];
    return { findings, protected: protectedCols, reid, risk, level, counts, regs, rowsScanned: rows.length, sampled, at: Date.now() };
  }

  // Pipeline steps that apply the recommended protection to the given findings (one step per method).
  function protectionSteps(findings, key) {
    const groups = new Map(), steps = [];
    for (const f of findings) {
      if (!f.fix) continue;
      if (f.fix.op === 'round') { steps.push({ op: 'round', params: { columns: [f.column], decimals: f.fix.decimals } }); continue; }
      const sig = JSON.stringify(f.fix); if (!groups.has(sig)) groups.set(sig, { fix: f.fix, cols: [] }); groups.get(sig).cols.push(f.column);
    }
    for (const { fix, cols } of groups.values()) steps.push({ op: 'mask', params: { columns: cols, ...fix, ...(fix.method === 'hash' ? { key } : {}) } });
    return steps.map(s => ({ id: 's_' + Math.random().toString(36).slice(2, 9), ...s }));
  }
  const newKey = () => { const a = new Uint8Array(16); (window.crypto || {}).getRandomValues ? crypto.getRandomValues(a) : a.forEach((_, i) => (a[i] = Math.random() * 256)); return [...a].map(x => x.toString(16).padStart(2, '0')).join(''); };

  /* ================= Data contracts ================= */
  const NUMERIC = (t) => t === 'number' || t === 'integer';
  // Turns "orders_2026_10.csv" into "orders_*.csv", so next month's file matches the same contract.
  function patternFor(name) { return String(name).replace(/\d+/g, '*').replace(/\*(?:[_\-. ]?\*)+/g, '*'); }
  function matchesPattern(pattern, name) {
    const re = new RegExp('^' + String(pattern).split('*').map(s => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$', 'i');
    return re.test(String(name));
  }

  function numValues(rows, ci, textNumeric) { const q = Q(), f = textNumeric ? q.looseNumber : q.toNumber, out = []; for (const r of rows) { const x = isNull(r[ci]) ? null : f(r[ci]); if (x !== null && Number.isFinite(x)) out.push(x); } return out; }
  // Baseline distribution: deciles for numbers (the standard PSI setup), top 20 categories plus "other" for text.
  function distOf(rows, ci, colProf) {
    if (NUMERIC(colProf.type)) {
      const xs = numValues(rows, ci, colProf.textNumeric).sort((a, b) => a - b); if (xs.length < 20) return null;
      const edges = [...new Set([1, 2, 3, 4, 5, 6, 7, 8, 9].map(k => Q().quantile(xs, k / 10)))];
      if (edges.length < 2) return null;
      return { kind: 'num', edges, probs: binProbs(xs, edges), n: xs.length, median: Q().quantile(xs, 0.5), mean: xs.reduce((s, x) => s + x, 0) / xs.length };
    }
    if (colProf.type === 'string' || colProf.type === 'boolean') {
      const m = new Map(); let n = 0; for (const r of rows) { const v = r[ci]; if (isNull(v)) continue; const k = String(v).trim(); m.set(k, (m.get(k) || 0) + 1); n++; }
      if (n < 20 || m.size > 60) return null;
      const top = [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20), probs = {}; let covered = 0;
      for (const [k, c] of top) { probs[k] = c / n; covered += c; }
      return { kind: 'cat', probs, other: 1 - covered / n, n };
    }
    return null;
  }
  function binProbs(xs, edges) { const c = new Array(edges.length + 1).fill(0); for (const x of xs) { let i = 0; while (i < edges.length && x > edges[i]) i++; c[i]++; } return c.map(v => v / Math.max(1, xs.length)); }
  const EPS = 1e-4;
  const psiOf = (e, o) => e.reduce((s, ei, i) => { const a = Math.max(EPS, o[i]), b = Math.max(EPS, ei); return s + (a - b) * Math.log(a / b); }, 0);
  // PSI rules of thumb from credit-risk monitoring: < 0.1 stable, 0.1-0.25 moderate shift, > 0.25 major shift.
  const driftLevel = (p) => (p > 0.25 ? 'major' : p > 0.1 ? 'moderate' : 'stable');

  function compareDist(base, rows, ci, colProf) {
    if (base.kind === 'num') {
      const xs = numValues(rows, ci, colProf.textNumeric); if (xs.length < 20) return null;
      const probs = binProbs(xs, base.edges), psi = psiOf(base.probs, probs);
      const sorted = [...xs].sort((a, b) => a - b), median = Q().quantile(sorted, 0.5), mean = xs.reduce((s, x) => s + x, 0) / xs.length;
      const bins = base.probs.map((p, i) => ({ label: i === 0 ? `≤ ${fmt(base.edges[0])}` : i === base.edges.length ? `> ${fmt(base.edges[i - 1])}` : `${fmt(base.edges[i - 1])} – ${fmt(base.edges[i])}`, before: p, after: probs[i] }));
      const moved = [...bins].sort((a, b) => Math.abs(b.after - b.before) - Math.abs(a.after - a.before))[0];
      const ch = base.median ? (median - base.median) / Math.abs(base.median) : null;
      const why = `Median ${fmt(base.median)} → ${fmt(median)}${ch !== null && Number.isFinite(ch) ? ` (${ch >= 0 ? '+' : ''}${(ch * 100).toFixed(1)}%)` : ''}; the ${moved.label} band went from ${pctTxt(moved.before)} to ${pctTxt(moved.after)} of rows.`;
      return { psi, level: driftLevel(psi), bins, why, before: { median: base.median, mean: base.mean }, after: { median, mean } };
    }
    const m = new Map(); let n = 0; for (const r of rows) { const v = r[ci]; if (isNull(v)) continue; const k = String(v).trim(); m.set(k, (m.get(k) || 0) + 1); n++; }
    if (n < 20) return null;
    const keys = Object.keys(base.probs), e = [...keys.map(k => base.probs[k]), base.other];
    let covered = 0; const o = keys.map(k => { const c = m.get(k) || 0; covered += c; return c / n; }); o.push(1 - covered / n);
    const psi = psiOf(e, o);
    const shifts = keys.map((k, i) => ({ label: k, before: e[i], after: o[i] }));
    const fresh = [...m.entries()].filter(([k]) => !(k in base.probs)).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k, c]) => ({ label: k, before: 0, after: c / n, isNew: true }));
    const bins = [...shifts, ...fresh].sort((a, b) => Math.abs(b.after - b.before) - Math.abs(a.after - a.before)).slice(0, 8);
    const top = bins[0];
    const why = top ? (top.isNew ? `New value "${top.label}" makes up ${pctTxt(top.after)} of rows.` : `"${top.label}" went from ${pctTxt(top.before)} to ${pctTxt(top.after)} of rows.`) + (fresh.length && !top.isNew ? ` ${fresh.length} value${fresh.length > 1 ? 's' : ''} never seen before.` : '') : '';
    return { psi, level: driftLevel(psi), bins, why, newValues: fresh.map(f => f.label) };
  }

  const rid = () => 'r_' + Math.random().toString(36).slice(2, 9);
  const isDateCol = (c) => c.type === 'date' && c.dateRange;

  /** Rules tuned from the dataset itself. `table` is the full table (or the large-file sample), `prof` its profile
   *  (exact for large files), `privacy` the scan, used so contracts never store personal values. */
  function buildContract({ name, datasetId, datasetName, table, prof, privacy }) {
    const rows = sampleRows(table.rows, 100000), pii = new Set((privacy?.findings || []).filter(f => f.category !== 'quasi' || f.kind === 'dob').map(f => f.column));
    const rules = [], dists = {};
    const add = (kind, column, params, severity = 'warn') => rules.push({ id: rid(), kind, column, params, severity, enabled: true });
    add('row_count', null, { min: Math.floor(prof.rows * 0.5), max: Math.ceil(prof.rows * 2) }, 'warn');
    add('columns', null, { expected: prof.columns.map(c => c.name), allowNew: true }, 'fail');
    for (const c of prof.columns) {
      const ci = c.index, nonNull = c.count - c.nulls;
      if (c.type !== 'empty') add('type', c.name, { type: c.type }, 'fail');
      if (c.nullPct === 0) add('max_nulls', c.name, { max: 0.01 }, 'fail');
      else add('max_nulls', c.name, { max: round(Math.min(1, Math.max(c.nullPct * 1.5, c.nullPct + 0.02)), 3) }, 'warn');
      if (c.uniquePct === 1 && c.nulls === 0 && prof.rows >= 20 && c.type !== 'boolean' && !NUMERIC(c.type) || (c.uniquePct === 1 && c.nulls === 0 && c.type === 'integer' && /(^|[^a-z])id$|_id$|^id_/i.test(c.name))) add('unique', c.name, {}, 'fail');
      if (NUMERIC(c.type) && c.stats && !pii.has(c.name)) {
        const span = (c.stats.max - c.stats.min) || Math.abs(c.stats.max) || 1;
        const pad = Math.max(0.25 * span, 3 * (c.stats.iqr || 0)); let lo = c.stats.min - pad, hi = c.stats.max + Math.max(pad, 0.5 * span); if (c.stats.min >= 0) lo = Math.max(0, lo);
        if (c.rangeRule) { if (c.rangeRule.min !== null && c.rangeRule.min !== undefined) lo = Math.max(lo, c.rangeRule.min); if (c.rangeRule.max !== null && c.rangeRule.max !== undefined) hi = Math.min(hi, c.rangeRule.max); }
        add('range', c.name, { min: round(lo, 6), max: round(hi, 6) }, 'warn');
      }
      if ((c.type === 'string' || c.type === 'boolean') && !pii.has(c.name) && c.unique <= 25 && nonNull >= 30) {
        const m = new Map(); for (const r of rows) { const v = r[ci]; if (!isNull(v)) { const k = String(v).trim(); m.set(k, (m.get(k) || 0) + 1); } }
        if (m.size <= 25) add('allowed_values', c.name, { values: [...m.keys()].sort(), maxOther: 0.01 }, 'warn');
      }
      if (/e-?mail/i.test(c.name) && c.type === 'string') { const bad = (c.issues.find(i => i.code === 'invalid_email') || {}).count || 0; add('email_format', c.name, { maxInvalid: round(Math.min(1, bad / Math.max(1, nonNull) + 0.01), 3) }, 'warn'); }
      if (isDateCol(c)) add('freshness', c.name, { notBefore: c.dateRange[1].slice(0, 10) }, 'warn');
      if (!pii.has(c.name)) { const d = distOf(rows, ci, c); if (d) { dists[c.name] = d; add('drift', c.name, { maxPsi: 0.25 }, 'warn'); } }
    }
    add('min_score', null, { min: Math.max(0, Math.floor(prof.score - 5)) }, 'warn');
    add('max_duplicates', null, { maxPct: round(prof.duplicates / Math.max(1, prof.rows) + 0.01, 3) }, 'warn');
    add('no_new_pii', null, { known: [...new Set((privacy?.findings || []).map(f => f.column))] }, 'fail');
    const stem = patternFor(datasetName).replace(/\.[a-z0-9]+$/i, '').replace(/\*/g, ' ').replace(/[_\-.]+/g, ' ').replace(/\s+/g, ' ').trim();
    return { v: 1, name: name || ((stem || 'Dataset') + ' files'), pattern: patternFor(datasetName), baseline: { datasetId, name: datasetName, rows: prof.rows, score: prof.score, sampled: rows.length < prof.rows, at: Date.now() }, rules, dists };
  }

  const RULE_LABEL = { row_count: 'Row count', columns: 'Schema', type: 'Type', max_nulls: 'Missing values', unique: 'Unique', range: 'Range', allowed_values: 'Allowed values', email_format: 'Email format', freshness: 'Freshness', drift: 'Distribution drift', min_score: 'Quality score', max_duplicates: 'Duplicates', no_new_pii: 'No new personal data' };
  function describeRule(r) {
    const p = r.params || {};
    switch (r.kind) {
      case 'row_count': return `Between ${fmt(p.min)} and ${fmt(p.max)} rows`;
      case 'columns': return `Has all ${p.expected.length} columns${p.allowNew ? '' : ' and no others'}`;
      case 'type': return `Is ${p.type}`;
      case 'max_nulls': return p.max <= 0.01 ? 'Is never missing (≤ 1%)' : `At most ${pctTxt(p.max)} missing`;
      case 'unique': return 'Every value is unique';
      case 'range': return `Between ${fmt(p.min)} and ${fmt(p.max)}`;
      case 'allowed_values': return `One of ${p.values.length} known values${p.values.length <= 6 ? ` (${p.values.join(', ')})` : ''}`;
      case 'email_format': return `At most ${pctTxt(p.maxInvalid)} malformed emails`;
      case 'freshness': return `Latest date is on or after ${p.notBefore}`;
      case 'drift': return `Distribution stays close to the baseline (PSI ≤ ${p.maxPsi})`;
      case 'min_score': return `Quality score at least ${p.min}`;
      case 'max_duplicates': return `At most ${pctTxt(p.maxPct)} duplicate rows`;
      case 'no_new_pii': return `No personal data outside ${p.known.length ? p.known.length + ' known column' + (p.known.length > 1 ? 's' : '') : 'any column'}`;
    }
    return r.kind;
  }

  /** Checks a dataset against a contract. `prof` is the dataset's profile (exact for large files) and `table` its
   *  rows (the sample for large files), used for value-level checks and drift. Returns rule results and drift. */
  function checkContract(spec, { table, prof, privacy, sampled }) {
    const rows = sampleRows(table.rows, 100000), byName = new Map(prof.columns.map(c => [c.name, c]));
    const results = [], drift = [];
    const res = (r, ok, observed, msg, extra = {}) => results.push({ id: r.id, kind: r.kind, column: r.column, severity: r.severity, status: ok ? 'pass' : r.severity, observed, expected: describeRule(r), msg, ...extra });
    for (const r of spec.rules) {
      if (!r.enabled) continue;
      const p = r.params || {}, c = r.column ? byName.get(r.column) : null;
      if (r.column && !c) continue; // the schema rule reports missing columns once
      switch (r.kind) {
        case 'row_count': res(r, prof.rows >= p.min && prof.rows <= p.max, fmt(prof.rows), prof.rows < p.min ? `Only ${fmt(prof.rows)} rows; expected at least ${fmt(p.min)}. The file may be truncated or a source may have stopped sending.` : prof.rows > p.max ? `${fmt(prof.rows)} rows; expected at most ${fmt(p.max)}. Check for duplicated loads.` : `${fmt(prof.rows)} rows`); break;
        case 'columns': {
          const have = new Set(prof.columns.map(x => x.name)), missing = p.expected.filter(x => !have.has(x)), extra = prof.columns.map(x => x.name).filter(x => !p.expected.includes(x));
          // a renamed column shows up as one missing plus one new with the same normalized name
          const nn = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, ''), similar = (a, b) => nn(a) === nn(b) || (nn(a).length >= 3 && nn(b).includes(nn(a))) || (nn(b).length >= 3 && nn(a).includes(nn(b)));
          const renamed = missing.map(m => [m, extra.find(e => similar(m, e))]).filter(x => x[1]);
          const ok = !missing.length && (p.allowNew || !extra.length);
          res(r, ok, `${prof.columns.length} columns`, ok ? (extra.length ? `All expected columns present; ${extra.length} new: ${extra.join(', ')}.` : 'All expected columns present.') : [missing.length ? `Missing: ${missing.join(', ')}.` : '', renamed.length ? `Looks renamed: ${renamed.map(([a, b]) => `${a} → ${b}`).join(', ')}.` : '', extra.length && !p.allowNew ? `Unexpected: ${extra.join(', ')}.` : ''].filter(Boolean).join(' '), { renamed });
          if (ok && extra.length) results[results.length - 1].status = 'info';
          break;
        }
        case 'type': res(r, c.type === p.type || (p.type === 'number' && c.type === 'integer'), c.type, c.type === p.type ? `${c.type}` : `Was ${p.type}, now ${c.type}${c.textNumeric ? ' (numbers stored as text)' : ''}.`, { fix: c.textNumeric || (NUMERIC(p.type) && c.type === 'string') ? { op: 'clean_numeric', params: { columns: [c.name] } } : p.type === 'date' ? { op: 'parse_dates', params: { columns: [c.name] } } : null }); break;
        case 'max_nulls': res(r, c.nullPct <= p.max + 1e-12, pctTxt(c.nullPct), `${pctTxt(c.nullPct)} missing (${fmt(c.nulls)} rows); limit ${pctTxt(p.max)}.`, { fix: c.nullPct > p.max ? { op: 'fill_null', params: { columns: [c.name], strategy: NUMERIC(c.type) ? 'median' : 'mode' } } : null }); break;
        case 'unique': { const dupes = c.count - c.nulls - c.unique; res(r, dupes <= 0 && !c.approx, c.approx ? '≈ ' + fmt(c.unique) + ' distinct' : fmt(c.unique) + ' distinct', dupes > 0 ? `${fmt(dupes)} repeated values.` : 'All values unique.', { fix: dupes > 0 ? { op: 'drop_duplicates', params: { columns: [c.name], keep: 'first' } } : null }); break; }
        case 'range': {
          if (!c.stats) { res(r, false, 'not numeric', `${c.name} is no longer numeric.`); break; }
          const ci = c.index, xs = numValues(rows, ci, c.textNumeric), out = xs.filter(x => x < p.min || x > p.max).length, share = out / Math.max(1, xs.length);
          const ok = c.stats.min >= p.min && c.stats.max <= p.max;
          res(r, ok, `${fmt(c.stats.min)} – ${fmt(c.stats.max)}`, ok ? `Min ${fmt(c.stats.min)}, max ${fmt(c.stats.max)}.` : `Values from ${fmt(c.stats.min)} to ${fmt(c.stats.max)}; about ${pctTxt(share, 2)} of rows fall outside ${fmt(p.min)} – ${fmt(p.max)}.`, { fix: ok ? null : { op: 'range_check', params: { column: c.name, min: p.min, max: p.max, action: 'null' } } });
          break;
        }
        case 'allowed_values': {
          const allowed = new Set(p.values), m = new Map(); let n = 0;
          for (const row of rows) { const v = row[c.index]; if (isNull(v)) continue; n++; const k = String(v).trim(); if (!allowed.has(k)) m.set(k, (m.get(k) || 0) + 1); }
          const other = [...m.values()].reduce((s, x) => s + x, 0) / Math.max(1, n), top = [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4);
          const variant = top.some(([k]) => p.values.some(v => v.toLowerCase().replace(/\s+/g, '') === k.toLowerCase().replace(/\s+/g, '')));
          res(r, other <= p.maxOther, pctTxt(other, 2) + ' unknown', other <= p.maxOther ? 'Only known values.' : `${pctTxt(other, 2)} of rows use values not in the contract: ${top.map(([k, x]) => `"${k}" (${fmt(x)})`).join(', ')}.`, { newValues: top.map(([k]) => k), fix: other > p.maxOther && variant ? { op: 'standardize_categories', params: { columns: [c.name] } } : null });
          break;
        }
        case 'email_format': { const bad = (c.issues.find(i => i.code === 'invalid_email') || {}).count || 0, share = bad / Math.max(1, c.count - c.nulls); res(r, share <= p.maxInvalid, pctTxt(share, 2), `${fmt(bad)} malformed (${pctTxt(share, 2)}).`); break; }
        case 'freshness': { const last = c.dateRange ? c.dateRange[1].slice(0, 10) : null; res(r, !!last && last >= p.notBefore, last || '—', !last ? 'No valid dates.' : last >= p.notBefore ? `Latest date ${last}.` : `Latest date is ${last}, older than the baseline's ${p.notBefore}. This may be an old export sent again.`); break; }
        case 'drift': {
          const base = spec.dists?.[r.column]; if (!base) break;
          const d = compareDist(base, rows, c.index, c); if (!d) break;
          drift.push({ column: r.column, ...d, kind: base.kind });
          res(r, d.psi <= p.maxPsi, 'PSI ' + d.psi.toFixed(3), `${d.level === 'stable' ? 'Stable' : d.level === 'moderate' ? 'Moderate shift' : 'Major shift'} (PSI ${d.psi.toFixed(3)}). ${d.why}`, { psi: d.psi });
          if (d.psi <= p.maxPsi && d.level === 'moderate') results[results.length - 1].status = 'info';
          break;
        }
        case 'min_score': res(r, prof.score >= p.min, String(prof.score), `Quality score ${prof.score} (baseline ${spec.baseline.score}).`); break;
        case 'max_duplicates': { const share = prof.duplicates / Math.max(1, prof.rows); res(r, share <= p.maxPct, pctTxt(share, 2), `${fmt(prof.duplicates)} duplicate rows (${pctTxt(share, 2)}).`, { fix: share > p.maxPct ? { op: 'drop_duplicates', params: { keep: 'first' } } : null }); break; }
        case 'no_new_pii': {
          const found = (privacy?.findings || []).filter(f => !p.known.includes(f.column) && f.confidence !== 'low');
          res(r, !found.length, found.length ? found.length + ' new' : 'none', found.length ? `New personal data: ${found.map(f => `${f.column} (${f.label.toLowerCase()})`).join(', ')}.` : 'No personal data in new columns.', { piiColumns: found.map(f => f.column), fix: found.length ? { op: 'protect', columns: found.map(f => f.column) } : null });
          break;
        }
      }
    }
    const count = (s) => results.filter(x => x.status === s).length;
    const status = count('fail') ? 'fail' : count('warn') ? 'warn' : 'pass';
    return { status, results, drift, counts: { pass: count('pass'), info: count('info'), warn: count('warn'), fail: count('fail') }, rows: prof.rows, score: prof.score, sampled: !!sampled, at: Date.now() };
  }

  // "Accept as the new normal": widen a rule so the observed value passes.
  function acceptResult(spec, result, { table, prof }) {
    const r = spec.rules.find(x => x.id === result.id); if (!r) return spec;
    const c = r.column ? prof.columns.find(x => x.name === r.column) : null, p = r.params;
    if (r.kind === 'row_count') { p.min = Math.min(p.min, Math.floor(prof.rows * 0.5)); p.max = Math.max(p.max, Math.ceil(prof.rows * 2)); }
    else if (r.kind === 'columns') { const names = prof.columns.map(x => x.name); p.expected = names; }
    else if (r.kind === 'type' && c) p.type = c.type;
    else if (r.kind === 'max_nulls' && c) p.max = round(Math.min(1, c.nullPct + 0.02), 3);
    else if (r.kind === 'range' && c && c.stats) { p.min = Math.min(p.min, c.stats.min); p.max = Math.max(p.max, c.stats.max); }
    else if (r.kind === 'allowed_values') p.values = [...new Set([...p.values, ...(result.newValues || [])])].sort();
    else if (r.kind === 'freshness' && c && c.dateRange) p.notBefore = c.dateRange[1].slice(0, 10);
    else if (r.kind === 'drift' && c) { const d = distOf(sampleRows(table.rows, 100000), c.index, c); if (d) spec.dists[r.column] = d; }
    else if (r.kind === 'min_score') p.min = Math.min(p.min, Math.floor(prof.score));
    else if (r.kind === 'max_duplicates') p.maxPct = round(prof.duplicates / Math.max(1, prof.rows) + 0.01, 3);
    else if (r.kind === 'no_new_pii') p.known = [...new Set([...p.known, ...(result.piiColumns || [])])];
    else if (r.kind === 'unique') r.enabled = false;
    else if (r.kind === 'email_format') p.maxInvalid = round(Math.min(1, parseFloat(result.observed) / 100 + 0.01), 3);
    return spec;
  }

  window.QGuard = { scanPrivacy, protectionSteps, newKey, KIND, CAT_LABEL, buildContract, checkContract, acceptResult, describeRule, RULE_LABEL, patternFor, matchesPattern, driftLevel, fmt };
})();
