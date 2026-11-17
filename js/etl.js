/* QuantETL engine: parsing, type inference, profiling, quality, transforms, analysis, code export. */
(function () {
  const NULL_TOKENS = new Set(['', 'na', 'n/a', 'null', 'nan', 'none', 'nil', '-', '--', '?', 'missing', 'undefined', '#n/a']);
  // Fast paths before trim/lowercase: no null token starts with a digit or is longer than 9 characters, so a value
  // that starts with a digit, or is longer with non-space ASCII at both ends, can't be one. Same result, much cheaper
  // on millions of cells.
  const isNull = (v) => {
    if (typeof v === 'string') {
      const n = v.length; if (n === 0) return true;
      const a = v.charCodeAt(0); if (a >= 48 && a <= 57) return false;
      if (n > 9) { const b = v.charCodeAt(n - 1); if (a > 32 && a < 127 && b > 32 && b < 127) return false; }
      return NULL_TOKENS.has(v.trim().toLowerCase());
    }
    return v === null || v === undefined || (typeof v === 'number' && Number.isNaN(v));
  };
  const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
  const pad = (n) => String(n).padStart(2, '0');
  // Loop-based min/max: Math.min(...arr) throws a RangeError once arr has more elements than the engine allows as call arguments (~65k in Safari, ~125k in Chrome).
  const minOf = (a) => { let m = Infinity; for (let i = 0; i < a.length; i++) if (a[i] < m) m = a[i]; return m; };
  const maxOf = (a) => { let m = -Infinity; for (let i = 0; i < a.length; i++) if (a[i] > m) m = a[i]; return m; };

  /* ---------- Parsing ---------- */
  function detectDelimiter(text) {
    const sample = text.split(/\r?\n/).slice(0, 10).join('\n');
    let best = ',', bestScore = -1;
    for (const d of [',', '\t', ';', '|']) {
      const counts = sample.split('\n').filter(Boolean).map(l => l.split(d).length);
      if (!counts.length) continue;
      const consistent = counts.every(c => c === counts[0]);
      const score = (counts[0] - 1) * (consistent ? 2 : 1);
      if (score > bestScore) { best = d; bestScore = score; }
    }
    return best;
  }

  function parseCSV(text, delimiter) {
    text = text.replace(/^﻿/, '');
    const d = delimiter || detectDelimiter(text);
    const rows = []; let row = [], field = '', q = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (q) {
        if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; }
        else field += c;
      } else if (c === '"' && field === '') q = true;
      else if (c === d) { row.push(field); field = ''; }
      else if (c === '\n' || c === '\r') {
        if (c === '\r' && text[i + 1] === '\n') i++;
        row.push(field); field = '';
        if (row.length > 1 || row[0] !== '') rows.push(row);
        row = [];
      } else field += c;
    }
    if (field !== '' || row.length) { row.push(field); rows.push(row); }
    if (!rows.length) throw new Error('The file is empty.');
    const header = rows.shift().map((h, i) => h.trim() || 'column_' + (i + 1));
    const seen = {};
    const columns = header.map(h => { if (seen[h]) { seen[h]++; return h + '_' + seen[h]; } seen[h] = 1; return h; });
    const w = columns.length;
    return { columns, rows: rows.map(r => { const o = r.slice(0, w); while (o.length < w) o.push(''); return o; }), delimiter: d };
  }

  function parseJSON(text) {
    let data = JSON.parse(text);
    if (!Array.isArray(data)) data = data.data || data.rows || data.records || Object.values(data).find(Array.isArray);
    if (!Array.isArray(data) || !data.length) throw new Error('JSON must be an array of records.');
    const cols = []; const set = new Set();
    data.forEach(r => Object.keys(r).forEach(k => { if (!set.has(k)) { set.add(k); cols.push(k); } }));
    return { columns: cols, rows: data.map(r => cols.map(c => r[c] === undefined || r[c] === null ? '' : (typeof r[c] === 'object' ? JSON.stringify(r[c]) : r[c]))) };
  }

  // JSONL / NDJSON: one JSON object per line. Nested objects become dot-path columns (meta.source); arrays and other
  // values that aren't plain scalars are kept as JSON text (a chat "messages" array stays intact), and toJSONL writes
  // them back as JSON. Missing keys and nulls are empty cells.
  function flattenRecord(obj, out = {}, prefix = '') {
    if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) { out[prefix || 'value'] = cellOf(obj); return out; }
    for (const k of Object.keys(obj)) {
      const v = obj[k], key = prefix ? prefix + '.' + k : k;
      if (v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length) flattenRecord(v, out, key);
      else out[key] = cellOf(v);
    }
    return out;
  }
  const cellOf = (v) => (v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : v);
  function parseJSONLines(text, onRecord) { // calls onRecord(flatObject) per non-blank line
    let line = 0, start = 0; const n = text.length;
    if (text.charCodeAt(0) === 0xfeff) start = 1;
    while (start < n) {
      let end = text.indexOf('\n', start); if (end < 0) end = n; line++;
      const s = text.slice(start, end).trim(); start = end + 1;
      if (!s) continue;
      let v; try { v = JSON.parse(s); } catch (e) { throw new Error(`Line ${line} is not valid JSON (${e.message.replace(/^JSON\.parse: |^Unexpected /, '')}).`); }
      onRecord(flattenRecord(v));
    }
  }
  function parseJSONL(text) {
    const recs = [], cols = [], set = new Set();
    parseJSONLines(text, (o) => { recs.push(o); for (const k in o) if (!set.has(k)) { set.add(k); cols.push(k); } });
    if (!recs.length) throw new Error('The file is empty.');
    return { columns: cols, rows: recs.map(o => cols.map(c => (c in o ? o[c] : ''))) };
  }

  function parseFile(name, text) {
    if (/\.(jsonl|ndjson)$/i.test(name)) return parseJSONL(text);
    if (/\.json$/i.test(name)) { try { return parseJSON(text); } catch (e) { if (/^\s*\{[^\n]*\}\s*\n\s*\{/.test(text.slice(0, 1 << 20))) return parseJSONL(text); throw e; } }
    return parseCSV(text, /\.tsv$/i.test(name) ? '\t' : undefined);
  }

  /* ---------- Value parsing ---------- */
  // The *S variants take an already trimmed, non-null string (the streaming profiler trims each value once).
  const NUM_RE = /^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i;
  const toNumberS = (s) => (NUM_RE.test(s) ? parseFloat(s) : null);
  function toNumber(v) {
    if (typeof v === 'number') return v;
    if (typeof v === 'boolean') return v ? 1 : 0;
    if (isNull(v)) return null;
    return toNumberS(String(v).trim());
  }
  function looseNumber(v) {
    const n = toNumber(v); if (n !== null) return n;
    if (isNull(v)) return null;
    return looseRestS(String(v).trim());
  }
  function looseNumberS(s) { const n = toNumberS(s); return n !== null ? n : looseRestS(s); }
  function looseRestS(s) {
    let neg = false;
    if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1); }
    s = s.replace(/[$€£¥₹\s]|USD|EUR|GBP/gi, '');
    let pct = false; if (s.endsWith('%')) { pct = true; s = s.slice(0, -1); }
    let mult = 1; const m = s.match(/^([-+]?[\d.,]+)\s*([kmb])$/i);
    if (m) { s = m[1]; mult = { k: 1e3, m: 1e6, b: 1e9 }[m[2].toLowerCase()]; }
    if (/^[-+]?\d{1,3}(,\d{3})+(\.\d+)?$/.test(s)) s = s.replace(/,/g, '');
    else if (/^[-+]?\d+,\d+$/.test(s)) s = s.replace(',', '.');
    if (!/^[-+]?(\d+\.?\d*|\.\d+)$/.test(s)) return null;
    // "%" is treated as a unit label (45.2% → 45.2), matching the exported pandas code. Dividing by 100 would corrupt
    // columns that mix "45.2" and "45.2%" (e.g. sensor humidity) and disagree with the pandas export.
    let n2 = parseFloat(s) * mult; void pct; if (neg) n2 = -n2;
    return n2;
  }
  function toBool(v) {
    if (typeof v === 'boolean') return v;
    if (isNull(v)) return null;
    const s = String(v).trim().toLowerCase();
    if (['true', 'yes', 'y', 't', '1'].includes(s)) return true;
    if (['false', 'no', 'n', 'f', '0'].includes(s)) return false;
    return null;
  }
  function parseDate(v, dayFirst = false) { return isNull(v) ? null : parseDateS(String(v).trim(), dayFirst); }
  function parseDateS(s, dayFirst = false) {
    let y, mo, d, time = '', m;
    if ((m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[T\s](\d{1,2}:\d{2}(?::\d{2})?))?/))) { y = +m[1]; mo = +m[2]; d = +m[3]; time = m[4] || ''; }
    else if ((m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})(?:\s+(\d{1,2}:\d{2}(?::\d{2})?))?$/))) {
      let a = +m[1], b = +m[2]; y = +m[3]; if (y < 100) y += y < 50 ? 2000 : 1900; time = m[4] || '';
      if (a > 12) { d = a; mo = b; } else if (b > 12) { mo = a; d = b; } else if (dayFirst) { d = a; mo = b; } else { mo = a; d = b; }
    }
    else if ((m = s.match(/^(\d{1,2})[-\s]([A-Za-z]{3,9})[-\s,]+(\d{2,4})$/))) { d = +m[1]; mo = MONTHS[m[2].slice(0, 4).toLowerCase()] || MONTHS[m[2].slice(0, 3).toLowerCase()]; y = +m[3]; if (y < 100) y += 2000; }
    else if ((m = s.match(/^([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})$/))) { mo = MONTHS[m[1].slice(0, 4).toLowerCase()] || MONTHS[m[1].slice(0, 3).toLowerCase()]; d = +m[2]; y = +m[3]; }
    else if ((m = s.match(/^(\d{8})$/)) && +s.slice(0, 4) > 1900) { y = +s.slice(0, 4); mo = +s.slice(4, 6); d = +s.slice(6, 8); }
    else return null;
    if (!mo || mo > 12 || d < 1 || d > 31 || y < 1000 || y > 2999) return null;
    const dt = new Date(Date.UTC(y, mo - 1, d));
    if (dt.getUTCMonth() !== mo - 1) return null;
    return `${y}-${pad(mo)}-${pad(d)}` + (time ? 'T' + (time.length === 5 ? time + ':00' : time).padStart(8, '0') : '');
  }
  function dateFormatOf(v) { return dateFormatS(String(v).trim()); }
  function dateFormatS(s) {
    if (/^\d{4}-\d{2}-\d{2}/.test(s)) return 'YYYY-MM-DD';
    if (/^\d{4}\/\d{1,2}\/\d{1,2}/.test(s)) return 'YYYY/MM/DD';
    if (/^\d{1,2}\/\d{1,2}\/\d{2,4}/.test(s)) return 'MM/DD/YYYY';
    if (/^\d{1,2}-\d{1,2}-\d{2,4}/.test(s)) return 'DD-MM-YYYY';
    if (/^\d{1,2}\.\d{1,2}\.\d{2,4}/.test(s)) return 'DD.MM.YYYY';
    if (/^\d{1,2}[-\s][A-Za-z]/.test(s)) return 'DD-Mon-YYYY';
    if (/^[A-Za-z]/.test(s)) return 'Mon DD, YYYY';
    return 'other';
  }

  /* ---------- Type inference ---------- */
  function inferType(values) {
    const nn = values.filter(v => !isNull(v));
    if (!nn.length) return { type: 'empty', confidence: 1 };
    const sample = nn.length > 3000 ? nn.filter((_, i) => i % Math.ceil(nn.length / 3000) === 0) : nn;
    let num = 0, int = 0, loose = 0, bool = 0, binary = 0, date = 0;
    for (const v of sample) {
      if (typeof v === 'boolean') { bool++; continue; }
      const n = toNumber(v);
      if (n !== null) { num++; if (Number.isInteger(n)) int++; }
      else if (looseNumber(v) !== null) loose++;
      const sv = String(v).trim().toLowerCase();
      if (['true', 'false', 'yes', 'no', 'y', 'n', 't', 'f'].includes(sv)) bool++;
      else if (sv === '1' || sv === '0') binary++;   // counts as boolean only alongside real yes/no words
      if (n === null && parseDate(v) !== null) date++;
      else if (n !== null && /^\d{8}$/.test(String(v).trim()) && parseDate(v)) date += 0;
    }
    const L = sample.length, r = (x) => x / L;
    if (r(bool) >= 0.95 || (bool > 0 && r(bool + binary) >= 0.95 && bool >= binary * 0.25)) return { type: 'boolean', confidence: r(bool + binary) };
    if (r(num) >= 0.95) return { type: int === num ? 'integer' : 'number', confidence: r(num) };
    if (r(num + loose) >= 0.85 && loose > 0) return { type: 'number', confidence: r(num + loose), textNumeric: true };
    if (r(date) >= 0.85) return { type: 'date', confidence: r(date) };
    return { type: 'string', confidence: 1 };
  }

  /* ---------- Stats ---------- */
  const sum = (a) => a.reduce((s, x) => s + x, 0);
  function quantile(sorted, q) {
    if (!sorted.length) return null;
    const pos = (sorted.length - 1) * q, lo = Math.floor(pos), hi = Math.ceil(pos);
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
  }
  function numStats(nums) { return nums.length ? numStatsSorted([...nums].sort((a, b) => a - b)) : null; }
  // Same arithmetic as before, in the same order, on an already sorted Array or Float64Array (the server sorts
  // millions of values in a Float64Array, which a plain Array of numbers could not hold).
  function numStatsSorted(s) {
    const n = s.length; if (!n) return null;
    let tot = 0; for (let i = 0; i < n; i++) tot += s[i];
    const mean = tot / n;
    let sq = 0; for (let i = 0; i < n; i++) sq += (s[i] - mean) ** 2;
    const variance = n > 1 ? sq / (n - 1) : 0;
    const std = Math.sqrt(variance), q1 = quantile(s, .25), q3 = quantile(s, .75), iqr = q3 - q1;
    let cube = 0; if (std > 0 && n > 2) for (let i = 0; i < n; i++) cube += ((s[i] - mean) / std) ** 3;
    const skew = std > 0 && n > 2 ? (cube * n) / ((n - 1) * (n - 2)) : 0;
    const lo = q1 - 1.5 * iqr, hi = q3 + 1.5 * iqr;
    let outliers = 0, zeros = 0, negatives = 0; for (let i = 0; i < n; i++) { const x = s[i]; if (x < lo || x > hi) outliers++; if (x === 0) zeros++; if (x < 0) negatives++; }
    return { n, min: s[0], max: s[n - 1], mean, median: quantile(s, .5), std, q1, q3, iqr, skew, outliers, outlierBounds: [lo, hi], zeros, negatives };
  }
  // Growable Float64Array for collecting numbers over a whole file.
  class NumBuf {
    constructor() { this.a = new Float64Array(1024); this.n = 0; }
    push(x) { if (this.n === this.a.length) { const b = new Float64Array(this.a.length * 2); b.set(this.a); this.a = b; } this.a[this.n++] = x; }
    sorted() { return this.a.subarray(0, this.n).sort(); }
  }
  // 53-bit row hashes in an open-addressing table: duplicate detection over millions of rows in a few hundred MB.
  // Two independent 32-bit FNV-1a hashes with a murmur3 finalizer; a false match needs a 52-bit collision.
  function hash2(str) {
    let a = 0x811c9dc5, b = 0x2545f491;
    for (let i = 0; i < str.length; i++) { const c = str.charCodeAt(i); a = Math.imul(a ^ c, 16777619); b = Math.imul(b ^ c, 0x01000193) ^ (b >>> 15); }
    return [fmix(a), fmix(b ^ str.length)];
  }
  // Row identity without building a JSON string: each value contributes a type tag, its length and its characters,
  // so ["1"] and [1], or ["a,b"] and ["a","b"], still differ. null, undefined and non-finite numbers share a tag
  // because JSON.stringify writes them all as null (the browser's duplicate check compares JSON strings).
  function hashRow(r) {
    let a = 0x811c9dc5, b = 0x2545f491;
    for (let k = 0; k < r.length; k++) {
      const v = r[k];
      let tag, str;
      if (typeof v === 'string') { tag = 1; str = v; }
      else if (typeof v === 'number') { if (Number.isFinite(v)) { tag = 2; str = String(v); } else { tag = 0; str = ''; } }
      else if (typeof v === 'boolean') { tag = 3; str = v ? '1' : '0'; }
      else if (v === null || v === undefined) { tag = 0; str = ''; }
      else { tag = 4; str = JSON.stringify(v); }
      a = Math.imul(a ^ tag, 16777619); b = Math.imul(b ^ (tag + 7), 0x01000193) ^ (b >>> 15);
      a = Math.imul(a ^ str.length, 16777619); b = Math.imul(b ^ str.length, 0x01000193) ^ (b >>> 15);
      for (let i = 0; i < str.length; i++) { const c = str.charCodeAt(i); a = Math.imul(a ^ c, 16777619); b = Math.imul(b ^ c, 0x01000193) ^ (b >>> 15); }
    }
    return [fmix(a), fmix(b ^ r.length)];
  }
  function hash1(str) { let a = 0x811c9dc5; for (let i = 0; i < str.length; i++) a = Math.imul(a ^ str.charCodeAt(i), 16777619); return fmix(a); }
  function fmix(h) { h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b); h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35); h ^= h >>> 16; return h >>> 0; }
  class RowHashSet {
    constructor(expected = 1 << 16) { let cap = 1 << 16; while (cap < expected * 2) cap *= 2; this.t = new Float64Array(cap); this.size = 0; }
    /** Adds a string key (add) or a row (addRow); returns false if it was already there. */
    add(str) { const [a, b] = hash2(str); return this.addHash(a, b); }
    addRow(r) { const [a, b] = hashRow(r); return this.addHash(a, b); }
    addHash(a, b) {
      const key = (a >>> 1) * 2097152 + (b >>> 11) + 1;
      if ((this.size + 1) * 2 > this.t.length) this.grow();
      return this.insert(key);
    }
    insert(key) { // the slot comes from the key's high 31 bits (already well mixed), so grow() can re-place keys
      const t = this.t, mask = t.length - 1; let i = Math.floor((key - 1) / 2097152) & mask;
      while (t[i] !== 0) { if (t[i] === key) return false; i = (i + 1) & mask; }
      t[i] = key; this.size++; return true;
    }
    grow() { const old = this.t; this.t = new Float64Array(old.length * 2); this.size = 0; for (const k of old) if (k !== 0) this.insert(k); }
  }
  function histogram(nums, bins = 20) {
    if (!nums.length) return [];
    let min = Infinity, max = -Infinity; for (const x of nums) { if (x < min) min = x; if (x > max) max = x; }
    if (min === max) return [{ x0: min, x1: max, count: nums.length }];
    const w = (max - min) / bins, out = Array.from({ length: bins }, (_, i) => ({ x0: min + i * w, x1: min + (i + 1) * w, count: 0 }));
    for (const x of nums) out[Math.min(bins - 1, Math.floor((x - min) / w))].count++;
    return out;
  }
  function valueCounts(values, limit = 10) {
    const m = new Map(); for (const v of values) { if (isNull(v)) continue; const k = String(v); m.set(k, (m.get(k) || 0) + 1); }
    return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([value, count]) => ({ value, count }));
  }
  const colValues = (t, ci) => t.rows.map(r => r[ci]);
  const colIndex = (t, name) => { const i = t.columns.indexOf(name); if (i < 0) throw new Error(`Column "${name}" not found.`); return i; };

  /* ---------- Range rules ---------- */
  // Plausible ranges inferred from common column names. Only used to *suggest*: a violation becomes an issue and
  // QETL R1 proposes a range step, but nothing changes until a step runs. `nums` lets percent columns pick 0–1 vs 0–100.
  const RANGE_HINTS = [
    [/(^|[^a-z])age([^a-z]|$)|_age$|^age_/i, 0, 120, 'a person\'s age'],
    [/(^|[^a-z])nps([^a-z]|$)|net.?promoter/i, 0, 10, 'an NPS score'],
    [/latitude|(^|[^a-z])lat([^a-z]|$)/i, -90, 90, 'a latitude'],
    [/longitude|(^|[^a-z])(lon|lng)([^a-z]|$)/i, -180, 180, 'a longitude'],
    [/battery|humidity|percent|pct|(^|[^a-z])pc([^a-z]|$)|utili[sz]ation/i, 0, 100, 'a percentage'],
    [/temp(erature)?(_c|_celsius)?$|temperature/i, -100, 150, 'a temperature in °C'],
    [/(^|[^a-z])(year|yr)([^a-z]|$)/i, 1900, 2100, 'a year'],
    [/stars?$|star_rating/i, 1, 5, 'a 1–5 star rating'],
    [/(^|[^a-z])(qty|quantity|units|count)([^a-z]|$)|_count$|^num_/i, 0, null, 'a count (cannot be negative)'],
    [/price|salary|income|cost|fee|wage|lifetime.?value|ltv/i, 0, null, 'a price or income (cannot be negative)'],
  ];
  function suggestRange(name, nums) {
    const n = String(name).replace(/[_\-.]+/g, ' ');
    for (const [re, min, max, why] of RANGE_HINTS) {
      if (!re.test(name) && !re.test(n)) continue;
      if (max === 100 && why === 'a percentage' && nums && nums.length) { // fractional percentages (0.45) use 0–1
        const s = [...nums].sort((a, b) => a - b), med = s[Math.floor(s.length / 2)]; if (med <= 1 && s[Math.floor(s.length * .95)] <= 1) return { min: 0, max: 1, why: 'a fraction (0–1)' };
      }
      return { min, max, why };
    }
    return null;
  }
  const inRange = (x, min, max) => (min === null || min === undefined || min === '' || x >= +min) && (max === null || max === undefined || max === '' || x <= +max);
  const rangeText = (min, max) => (min !== null && min !== undefined && min !== '' ? min : '−∞') + ' to ' + (max !== null && max !== undefined && max !== '' ? max : '∞');

  /* ---------- Profiling ---------- */
  // A column profile is built in two steps: summarizeColumn() reduces the values to counts and stats, and
  // columnFromSummary() turns those into the profile and its issues. The server's streaming profiler (createProfiler)
  // builds the same summary chunk by chunk for large files, so both produce identical issues and messages.
  function variantsOf(counts) {
    const groups = new Map();
    for (const v of counts.keys()) { const k = v.trim().toLowerCase().replace(/\s+/g, ' '); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(v); }
    const variants = [...groups.values()].filter(g => g.length > 1);
    let count = 0; for (const g of variants) for (const v of g) count += counts.get(v);
    return { variants, count };
  }
  const topOf = (counts, limit) => [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([value, count]) => ({ value, count }));
  const relabelFormats = (raw, dayFirst) => { const m = new Map(); for (const [f, c] of raw) { const k = dayFirst && f === 'MM/DD/YYYY' ? 'DD/MM/YYYY' : f; m.set(k, (m.get(k) || 0) + c); } return m; };
  const SLASH_DATE = /^(\d{1,2})[\/.-](\d{1,2})[\/.-]\d{2,4}/;
  const EMAIL_NAME = /e-?mail/i, EMAIL_OK = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  function summarizeColumn(vals, name) {
    const nn = vals.filter(v => !isNull(v)), inf = inferType(vals);
    const counts = new Map(); for (const v of nn) { const k = String(v); counts.set(k, (counts.get(k) || 0) + 1); }
    const S = { n: vals.length, nulls: vals.length - nn.length, nonNull: nn.length, inf, unique: counts.size, top: topOf(counts, 8),
      nullTokens: vals.filter(v => typeof v === 'string' && v.trim() !== '' && isNull(v)).length };
    if (['number', 'integer'].includes(inf.type)) {
      const nums = nn.map(inf.textNumeric ? looseNumber : toNumber).filter(x => x !== null);
      S.numeric = nums.length; S.stats = numStats(nums);
      if (S.stats && S.stats.iqr > 0) { const lo = S.stats.q1 - 3 * S.stats.iqr, hi = S.stats.q3 + 3 * S.stats.iqr, inside = nums.filter(x => x >= lo && x <= hi); S.hist = histogram(inside); S.histClipped = nums.length - inside.length; }
      else { S.hist = histogram(nums); S.histClipped = 0; }
      if (inf.textNumeric) S.textNumeric = nn.filter(v => toNumber(v) === null).length;
      const rule = suggestRange(name, nums);
      if (rule) { S.rangeRule = rule; const out = nums.filter(x => !inRange(x, rule.min, rule.max)); S.outOfRange = out.length; S.outExamples = [...new Set(out)].slice(0, 3); }
    } else if (inf.type === 'date') {
      const slash = nn.map(v => String(v).trim().match(SLASH_DATE)).filter(Boolean);
      S.dayFirst = slash.some(x => +x[1] > 12) && !slash.some(x => +x[2] > 12);
      const parsed = nn.map(v => parseDate(v, S.dayFirst)).filter(Boolean).sort();
      S.parsed = parsed.length; S.dateRange = parsed.length ? [parsed[0], parsed[parsed.length - 1]] : null;
      const raw = new Map(); for (const v of nn) { const f = dateFormatOf(v); raw.set(f, (raw.get(f) || 0) + 1); }
      S.dateFormats = topOf(relabelFormats(raw, S.dayFirst), 6);
    } else if (inf.type === 'string') {
      const lens = nn.map(v => String(v).length); S.len = { min: minOf(lens), max: maxOf(lens), mean: lens.length ? sum(lens) / lens.length : 0 };
      S.whitespace = nn.filter(v => typeof v === 'string' && (v !== v.trim() || /\s{2,}/.test(v))).length;
      if (S.unique < 200) S.variants = variantsOf(counts);
      if (EMAIL_NAME.test(name)) S.badEmails = nn.filter(v => !EMAIL_OK.test(String(v).trim())).length;
    } else if (inf.type === 'boolean') S.boolForms = [...new Set(nn.map(v => String(v).trim().toLowerCase()))];
    return S;
  }

  function columnFromSummary(name, ci, S) {
    const inf = S.inf, n = S.n;
    const p = { name, index: ci, type: inf.type, textNumeric: !!inf.textNumeric, count: n, nulls: S.nulls, nullPct: n ? S.nulls / n : 0, unique: S.unique, uniquePct: S.nonNull ? S.unique / S.nonNull : 0, top: S.top, issues: [] };
    if (S.approx) p.approx = S.approx;
    if (S.nullTokens) p.issues.push({ sev: 'warning', code: 'null_tokens', msg: `${S.nullTokens} placeholder values (e.g. "N/A", "null") should be real nulls`, count: S.nullTokens });
    if (p.nullPct > 0) p.issues.push({ sev: p.nullPct > 0.3 ? 'serious' : 'warning', code: 'missing', msg: `${(p.nullPct * 100).toFixed(1)}% missing (${S.nulls} rows)`, count: S.nulls });
    if (['number', 'integer'].includes(inf.type)) {
      p.stats = S.stats; p.hist = S.hist; p.histClipped = S.histClipped;
      if (inf.textNumeric) p.issues.push({ sev: 'serious', code: 'text_numeric', msg: `${S.textNumeric} numbers stored as text (currency, commas or %)`, count: S.textNumeric });
      const bad = S.nonNull - S.numeric;
      if (bad > 0) p.issues.push({ sev: 'serious', code: 'invalid_type', msg: `${bad} values are not numeric`, count: bad });
      if (p.stats && p.stats.outliers > 0) p.issues.push({ sev: p.stats.outliers / S.numeric > 0.05 ? 'serious' : 'warning', code: 'outliers', msg: `${p.stats.outliers} outliers outside IQR × 1.5`, count: p.stats.outliers });
      if (p.stats && Math.abs(p.stats.skew) > 2) p.issues.push({ sev: 'info', code: 'skew', msg: `Highly skewed (skew ${p.stats.skew.toFixed(2)}); prefer median over mean`, count: 0 });
      if (S.rangeRule) {
        const rule = p.rangeRule = S.rangeRule;
        if (S.outOfRange) p.issues.push({ sev: 'serious', code: 'out_of_range', count: S.outOfRange, range: { min: rule.min, max: rule.max },
          msg: `${S.outOfRange} values outside the plausible range ${rangeText(rule.min, rule.max)} for ${rule.why} (e.g. ${S.outExamples.join(', ')})` });
      }
    } else if (inf.type === 'date') {
      p.dateRange = S.dateRange; p.dayFirst = S.dayFirst; const fm = p.dateFormats = S.dateFormats;
      if (fm.length > 1) p.issues.push({ sev: 'serious', code: 'mixed_dates', msg: `${fm.length} date formats mixed (${fm.map(f => f.value).join(', ')})`, count: S.nonNull - fm[0].count });
      else if (fm[0] && fm[0].value !== 'YYYY-MM-DD') p.issues.push({ sev: 'info', code: 'non_iso', msg: `Dates use ${fm[0].value}; convert to ISO 8601`, count: S.nonNull });
      const bad = S.nonNull - S.parsed; if (bad) p.issues.push({ sev: 'serious', code: 'invalid_type', msg: `${bad} values are not valid dates`, count: bad });
    } else if (inf.type === 'string') {
      p.len = S.len;
      if (S.whitespace) p.issues.push({ sev: 'warning', code: 'whitespace', msg: `${S.whitespace} values have leading, trailing or repeated spaces`, count: S.whitespace });
      const vr = S.variants;
      if (vr && vr.variants.length && S.unique < 200) p.issues.push({ sev: 'warning', code: 'inconsistent_case', msg: `${vr.variants.length} categories with spelling/case variants (e.g. ${vr.variants[0].slice(0, 3).map(x => '"' + x + '"').join(', ')})`, count: vr.count, variants: vr.variants.slice(0, 5) });
      if (S.badEmails) p.issues.push({ sev: 'serious', code: 'invalid_email', msg: `${S.badEmails} malformed email addresses`, count: S.badEmails });
    } else if (inf.type === 'boolean') {
      const forms = S.boolForms; if (forms.length > 2) p.issues.push({ sev: 'warning', code: 'bool_forms', msg: `Booleans written ${forms.length} ways (${forms.slice(0, 4).join(', ')})`, count: S.nonNull });
    } else if (inf.type === 'empty') p.issues.push({ sev: 'serious', code: 'empty', msg: 'Column is entirely empty', count: n });
    if (S.unique === 1 && S.nonNull > 1) p.issues.push({ sev: 'info', code: 'constant', msg: 'Column has a single constant value', count: 0 });
    return p;
  }

  function profileColumn(t, ci) { return columnFromSummary(t.columns[ci], ci, summarizeColumn(colValues(t, ci), t.columns[ci])); }

  function duplicateCount(t) {
    const s = new Set(); let d = 0;
    for (const r of t.rows) { const k = JSON.stringify(r); if (s.has(k)) d++; else s.add(k); }
    return d;
  }

  function assembleProfile(columns, rows, dups) {
    const cells = rows * columns.length;
    const nulls = sum(columns.map(c => c.nulls));
    const completeness = cells ? 1 - nulls / cells : 1;
    const uniqueness = rows ? 1 - dups / rows : 1;
    const invalid = sum(columns.flatMap(c => c.issues.filter(i => ['invalid_type', 'text_numeric', 'invalid_email', 'null_tokens', 'out_of_range'].includes(i.code)).map(i => i.count)));
    const validity = cells ? Math.max(0, 1 - invalid / cells) : 1;
    const inconsistent = sum(columns.flatMap(c => c.issues.filter(i => ['whitespace', 'inconsistent_case', 'mixed_dates', 'bool_forms'].includes(i.code)).map(i => i.count)));
    const consistency = cells ? Math.max(0, 1 - inconsistent / cells) : 1;
    const score = Math.floor((completeness * 0.3 + uniqueness * 0.2 + validity * 0.3 + consistency * 0.2) * 1000 + 1e-9) / 10;
    const issues = [];
    if (dups) issues.push({ sev: 'serious', code: 'duplicates', column: null, msg: `${dups} exact duplicate rows`, count: dups });
    columns.forEach(c => c.issues.forEach(i => issues.push({ ...i, column: c.name })));
    const rank = { serious: 0, warning: 1, info: 2 };
    issues.sort((a, b) => rank[a.sev] - rank[b.sev] || b.count - a.count);
    return { rows, cols: columns.length, cells, nulls, duplicates: dups, completeness, uniqueness, validity, consistency, score, columns, issues };
  }
  function profile(t) { return assembleProfile(t.columns.map((_, i) => profileColumn(t, i)), t.rows.length, duplicateCount(t)); }

  /* ---------- Streaming profiler (server, large files) ----------
     Pass 1 (addSample): counts rows and keeps a uniform 200k-row reservoir sample. decide(): picks each column's
     type, range rule and outlier bounds from that sample using the same functions as profile(). Pass 2 (add): exact
     counts over every row: nulls, placeholders, distinct values, invalid values, ranges, date formats, duplicates.
     Quartiles, skew and the histogram shape come from the sample and are marked approximate. */
  const DISTINCT_CAP = 100000;
  const ownStr = (v) => (typeof v === 'string' && v.length > 12 ? (' ' + v).slice(1) : v); // see own() below
  const ownRow = (r) => r.map(ownStr);
  function hllNew() { return new Uint8Array(1 << 14); }
  function hllAdd(R, str) { const h = hash1(str); const i = h >>> 18, w = (h << 14) | 0x2000; const rho = Math.clz32(w) + 1; if (rho > R[i]) R[i] = rho; }
  function hllCount(R) { const m = R.length; let z = 0, zeros = 0; for (const x of R) { z += 2 ** -x; if (!x) zeros++; } let e = 0.7213 / (1 + 1.079 / m) * m * m / z; if (e <= 2.5 * m && zeros) e = m * Math.log(m / zeros); return Math.round(e); }
  const fastNull = (v) => { // isNull() for parsed CSV strings, skipping trim/lowercase when the value can't be a token
    if (v === '') return true;
    if (v.length > 9) { const a = v.charCodeAt(0), b = v.charCodeAt(v.length - 1); if (a > 32 && a < 127 && b > 32 && b < 127) return false; }
    return NULL_TOKENS.has(v.trim().toLowerCase());
  };

  function createProfiler(columns, opts = {}) {
    const W = columns.length, SAMPLE = opts.sample || 200000;
    let seed = opts.seed || 20261108; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    let total = 0, res = [], decided = null, seen = 0, dupSet = null, dups = 0;
    const api = {
      columns,
      get rows() { return total; },
      addSample(rows) {
        for (const r of rows) {
          if (res.length < SAMPLE) res.push([total, ownRow(r)]);
          else { const j = Math.floor(rnd() * (total + 1)); if (j < SAMPLE) res[j] = [total, ownRow(r)]; }
          total++;
        }
      },
      sampleRows(k) { // up to k rows spread evenly through the file, in file order
        const sorted = [...res].sort((a, b) => a[0] - b[0]); if (sorted.length <= k) return sorted.map(x => x[1]);
        const out = [], step = sorted.length / k; for (let i = 0; i < k; i++) out.push(sorted[Math.floor(i * step)][1]); return out;
      },
      decide() {
        const rows = [...res].sort((a, b) => a[0] - b[0]).map(x => x[1]);
        decided = columns.map((name, ci) => {
          const vals = rows.map(r => r[ci]), inf = inferType(vals), c = { name, inf, nulls: 0, tokens: 0, nn: 0, counts: new Map(), hll: null };
          if (['number', 'integer'].includes(inf.type)) {
            const nums = vals.filter(v => !isNull(v)).map(inf.textNumeric ? looseNumber : toNumber).filter(x => x !== null);
            const st = numStats(nums);
            c.kind = 1; c.sampleStats = st; c.rule = suggestRange(name, nums);
            c.num = 0; c.mean = 0; c.m2 = 0; c.min = Infinity; c.max = -Infinity; c.zeros = 0; c.neg = 0; c.textNum = 0; c.out = 0; c.outEx = []; c.outSet = new Set(); c.outliers = 0; c.clipped = 0;
            if (st) { c.ob = st.outlierBounds; if (st.iqr > 0) { c.hb = [st.q1 - 3 * st.iqr, st.q3 + 3 * st.iqr]; c.sampleInside = nums.filter(x => x >= c.hb[0] && x <= c.hb[1]); } else c.sampleInside = nums; }
          } else if (inf.type === 'date') { c.kind = 2; c.parsed = 0; c.dmin = null; c.dmax = null; c.emin = null; c.emax = null; c.a12 = false; c.b12 = false; c.fmt = new Map(); }
          else if (inf.type === 'string') { c.kind = 3; c.lmin = Infinity; c.lmax = -Infinity; c.lsum = 0; c.ws = 0; c.email = EMAIL_NAME.test(name); c.badEmail = 0; }
          else if (inf.type === 'boolean') { c.kind = 4; c.forms = new Set(); }
          else c.kind = 0;
          return c;
        });
        dupSet = new RowHashSet(total);
      },
      add(rows) {
        for (const r of rows) {
          if (!dupSet.addRow(r)) dups++;
          for (let ci = 0; ci < W; ci++) {
            const c = decided[ci], v = r[ci];
            if (typeof v === 'string' ? fastNull(v) : isNull(v)) { c.nulls++; if (typeof v === 'string' && v.trim() !== '') c.tokens++; continue; }
            c.nn++;
            const key = String(v), tv = typeof v === 'string' ? v.trim() : null;
            if (!c.hll) { const k = c.counts.get(key); if (k !== undefined) c.counts.set(key, k + 1); else if (c.counts.size < DISTINCT_CAP) c.counts.set(ownStr(key), 1); else { c.hll = hllNew(); for (const x of c.counts.keys()) hllAdd(c.hll, x); hllAdd(c.hll, key); } }
            else { hllAdd(c.hll, key); const k = c.counts.get(key); if (k !== undefined) c.counts.set(key, k + 1); }
            switch (c.kind) {
              case 1: {
                let x = tv !== null ? toNumberS(tv) : toNumber(v);
                if (x === null && c.inf.textNumeric) { c.textNum++; x = tv !== null ? looseRestS(tv) : looseNumber(v); }
                if (x === null) break;
                c.num++; const d = x - c.mean; c.mean += d / c.num; c.m2 += d * (x - c.mean);
                if (x < c.min) c.min = x; if (x > c.max) c.max = x; if (x === 0) c.zeros++; if (x < 0) c.neg++;
                if (c.ob && (x < c.ob[0] || x > c.ob[1])) c.outliers++;
                if (c.hb && (x < c.hb[0] || x > c.hb[1])) c.clipped++;
                if (c.rule && !inRange(x, c.rule.min, c.rule.max)) { c.out++; if (c.outEx.length < 3 && !c.outSet.has(x)) { c.outSet.add(x); c.outEx.push(x); } }
                break;
              }
              case 2: {
                const t = tv !== null ? tv : key.trim();
                const d = parseDateS(t); if (d) { c.parsed++; if (c.dmin === null || d < c.dmin) c.dmin = d; if (c.dmax === null || d > c.dmax) c.dmax = d;
                  const e = parseDateS(t, true); if (c.emin === null || e < c.emin) c.emin = e; if (c.emax === null || e > c.emax) c.emax = e; } // e: the day-first reading, used if the column turns out day-first
                const m = t.match(SLASH_DATE); if (m) { if (+m[1] > 12) c.a12 = true; if (+m[2] > 12) c.b12 = true; }
                const f = dateFormatS(t); c.fmt.set(f, (c.fmt.get(f) || 0) + 1);
                break;
              }
              case 3: {
                const L = key.length; if (L < c.lmin) c.lmin = L; if (L > c.lmax) c.lmax = L; c.lsum += L;
                if (tv !== null && (v !== tv || /\s{2,}/.test(v))) c.ws++;
                if (c.email && !EMAIL_OK.test(tv !== null ? tv : key.trim())) c.badEmail++;
                break;
              }
              case 4: if (c.forms.size < 1000) c.forms.add((tv !== null ? tv : key.trim()).toLowerCase()); break;
            }
          }
          seen++;
        }
      },
      finish() {
        const sampleN = res.length, exact = sampleN === total;
        const cols = decided.map((c, ci) => {
          const unique = c.hll ? Math.max(hllCount(c.hll), c.counts.size) : c.counts.size;
          const S = { n: seen, nulls: c.nulls, nonNull: c.nn, inf: c.inf, unique, top: topOf(c.counts, 8), nullTokens: c.tokens };
          const approx = []; if (c.hll) approx.push('unique', 'top');
          if (c.kind === 1) {
            S.numeric = c.num; const st = c.sampleStats;
            if (c.num && exact) { S.stats = st; const sIn = c.sampleInside || []; S.hist = histogram(sIn); S.histClipped = c.num - sIn.length; }
            else if (c.num) {
              S.stats = { n: c.num, min: c.min, max: c.max, mean: c.mean, median: st ? st.median : c.mean, std: c.num > 1 ? Math.sqrt(c.m2 / (c.num - 1)) : 0, q1: st ? st.q1 : c.min, q3: st ? st.q3 : c.max, iqr: st ? st.iqr : 0, skew: st ? st.skew : 0, outliers: c.outliers, outlierBounds: c.ob || [c.min, c.max], zeros: c.zeros, negatives: c.neg };
              const inside = c.num - c.clipped, sIn = c.sampleInside || [], scale = sIn.length ? inside / sIn.length : 1;
              S.hist = histogram(sIn).map(b => ({ ...b, count: Math.round(b.count * scale) })); S.histClipped = c.clipped;
              if (!exact) approx.push('median', 'q1', 'q3', 'iqr', 'skew', 'outliers', 'hist');
            } else { S.stats = null; S.hist = []; S.histClipped = 0; }
            if (c.inf.textNumeric) S.textNumeric = c.textNum;
            if (c.rule) { S.rangeRule = c.rule; S.outOfRange = c.out; S.outExamples = c.outEx; }
          } else if (c.kind === 2) {
            S.parsed = c.parsed; S.dayFirst = c.a12 && !c.b12; S.dateRange = c.parsed ? (S.dayFirst ? [c.emin, c.emax] : [c.dmin, c.dmax]) : null;
            S.dateFormats = topOf(relabelFormats(c.fmt, S.dayFirst), 6);
          } else if (c.kind === 3) {
            S.len = { min: c.nn ? c.lmin : Infinity, max: c.nn ? c.lmax : -Infinity, mean: c.nn ? c.lsum / c.nn : 0 }; S.whitespace = c.ws;
            if (unique < 200 && !c.hll) S.variants = variantsOf(c.counts);
            if (c.email) S.badEmails = c.badEmail;
          } else if (c.kind === 4) S.boolForms = [...c.forms];
          if (!exact) approx.push('type');
          if (approx.length) S.approx = approx;
          return columnFromSummary(c.name, ci, S);
        });
        const prof = assembleProfile(cols, seen, dups);
        prof.sample = { rows: sampleN, of: total };
        return prof;
      },
    };
    return api;
  }

  /* ---------- Personal data patterns (shared by the mask step and the privacy scan in guard.js) ---------- */
  // Validators cut false positives: card numbers must pass the Luhn check, IBANs the ISO 7064 mod-97 check.
  const digitsOf = (s) => s.replace(/\D/g, '');
  function luhn(d) { let s = 0, alt = false; for (let i = d.length - 1; i >= 0; i--) { let x = d.charCodeAt(i) - 48; if (alt) { x *= 2; if (x > 9) x -= 9; } s += x; alt = !alt; } return s % 10 === 0; }
  function ibanOk(v) {
    const s = v.replace(/\s+/g, '').toUpperCase(); if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(s)) return false;
    const r = s.slice(4) + s.slice(0, 4); let m = 0;
    for (const ch of r) { const c = ch.charCodeAt(0); const part = c >= 65 ? String(c - 55) : ch; for (const dg of part) m = (m * 10 + (dg.charCodeAt(0) - 48)) % 97; }
    return m === 1;
  }
  const PII = {
    email: (s) => /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(s),
    card: (s) => /^\d(?:[ -]?\d){12,18}$/.test(s) && /^[3-6]/.test(s) && luhn(digitsOf(s)),
    iban: (s) => ibanOk(s),
    ssn: (s) => { const m = /^(\d{3})-(\d{2})-(\d{4})$/.exec(s); return !!m && m[1] !== '000' && m[1] !== '666' && m[1][0] !== '9' && m[2] !== '00' && m[3] !== '0000'; },
    ni: (s) => /^(?!BG|GB|NK|KN|TN|NT|ZZ)[A-CEGHJ-PR-TW-Z][A-CEGHJ-NPR-TW-Z] ?\d{2} ?\d{2} ?\d{2} ?[A-D]$/i.test(s),
    phone: (s) => { if (!/^\+?[\d\s().-]{7,22}$/.test(s)) return false; const d = digitsOf(s); return d.length >= 7 && d.length <= 15 && (/^\+/.test(s) || /[\s().-]/.test(s.trim())); },
    ipv4: (s) => /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/.test(s),
    ipv6: (s) => s.includes(':') && /^[0-9a-f:]{6,39}$/i.test(s) && (s.match(/:/g) || []).length >= 2 && /[0-9a-f]{1,4}:[0-9a-f]{1,4}/i.test(s),
  };
  // Patterns found inside free text (support notes, comments). Each replacement keeps the text readable.
  const TEXT_PII = [
    ['email', /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[EMAIL]'],
    ['iban', /\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){2,7}(?: ?[A-Z0-9]{1,4})?\b/g, '[IBAN]', ibanOk],
    ['card', /\b(?:\d[ -]?){12,18}\d\b/g, '[CARD]', (m) => /^[3-6]/.test(m) && luhn(digitsOf(m))],
    ['ssn', /\b\d{3}-\d{2}-\d{4}\b/g, '[SSN]', (m) => PII.ssn(m)],
    ['phone', /(?<!\d[,.]?)(?:\+\d{1,3}[ .-]?)?\(?\d{2,4}\)?[ .-]\d{3,4}[ .-]?\d{3,4}\b(?![,.]\d)/g, '[PHONE]', (m) => { const d = digitsOf(m); return d.length >= 7 && d.length <= 15; }],
    ['ipv4', /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/g, '[IP]'],
  ];
  function findTextPII(s) { const out = []; for (const [kind, re, , ok] of TEXT_PII) { re.lastIndex = 0; let m; while ((m = re.exec(s))) if (!ok || ok(m[0])) { out.push(kind); break; } } return out; }
  function redactTextPII(s) { let v = s; for (const [, re, rep, ok] of TEXT_PII) { re.lastIndex = 0; v = v.replace(re, (m) => (!ok || ok(m) ? rep : m)); } return v; }

  // SHA-256 (FIPS 180-4), synchronous so the mask step can run inside chunked server jobs. Returns hex.
  const SHA_K = new Uint32Array([0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2]);
  function sha256(str) {
    const bytes = typeof TextEncoder !== 'undefined' ? new TextEncoder().encode(str) : Buffer.from(str, 'utf8');
    const n = bytes.length, total = ((n + 9 + 63) >> 6) << 6, m = new Uint8Array(total); m.set(bytes); m[n] = 0x80;
    const bits = n * 8; m[total - 4] = bits >>> 24; m[total - 3] = bits >>> 16; m[total - 2] = bits >>> 8; m[total - 1] = bits; m[total - 5] = Math.floor(bits / 2 ** 32);
    const H = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]), W = new Uint32Array(64);
    const rot = (x, k) => (x >>> k) | (x << (32 - k));
    for (let o = 0; o < total; o += 64) {
      for (let i = 0; i < 16; i++) W[i] = (m[o + 4 * i] << 24) | (m[o + 4 * i + 1] << 16) | (m[o + 4 * i + 2] << 8) | m[o + 4 * i + 3];
      for (let i = 16; i < 64; i++) { const a = W[i - 15], b = W[i - 2]; W[i] = (W[i - 16] + (rot(a, 7) ^ rot(a, 18) ^ (a >>> 3)) + W[i - 7] + (rot(b, 17) ^ rot(b, 19) ^ (b >>> 10))) | 0; }
      let [a, b, c, d, e, f, g, h] = H;
      for (let i = 0; i < 64; i++) {
        const t1 = (h + (rot(e, 6) ^ rot(e, 11) ^ rot(e, 25)) + ((e & f) ^ (~e & g)) + SHA_K[i] + W[i]) | 0;
        const t2 = ((rot(a, 2) ^ rot(a, 13) ^ rot(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) | 0;
        h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
      }
      H[0] += a; H[1] += b; H[2] += c; H[3] += d; H[4] += e; H[5] += f; H[6] += g; H[7] += h;
    }
    return [...H].map(x => x.toString(16).padStart(8, '0')).join('');
  }
  // Pseudonym for one value: same input and key give the same token, so joins and counts still work after masking.
  const pseudoNorm = (s) => (s.includes('@') ? s.trim().toLowerCase() : s.trim());
  const pseudonym = (v, key) => 'tok_' + sha256((key || '') + '|' + pseudoNorm(String(v))).slice(0, 16);
  function partialMask(v, keep) {
    const s = String(v), k = Math.max(0, keep ?? 4);
    if (PII.email(s.trim())) { const [local, dom] = s.trim().split('@'); return local[0] + '***@' + dom; }
    let seen = 0; const out = s.split('');
    for (let i = out.length - 1; i >= 0; i--) if (/[A-Za-z0-9]/.test(out[i])) { if (seen >= k) out[i] = '*'; seen++; }
    return out.join('');
  }
  // as: 'band' (numbers to ranges like 30-39), 'year' (dates to their year), 'prefix' (codes such as ZIP or postcode to
  // their first characters), or 'auto' (dates to year, small numbers to bands, longer digit codes to a prefix).
  function generalize(v, bucket, as = 'auto', keep = 3) {
    const s = String(v).trim(), x = toNumber(s), k = Math.max(1, +keep || 3);
    const band = () => { const w = Math.max(1e-9, +bucket || 10), lo = Math.floor(x / w) * w; return `${lo}-${lo + w - (Number.isInteger(w) ? 1 : 0)}`; };
    const prefix = () => s.slice(0, k).toUpperCase() + '*'.repeat(Math.max(0, s.replace(/\s/g, '').length - k));
    const year = () => { const d = parseDateS(s); return d ? d.slice(0, 4) : null; };
    if (as === 'band') return x === null ? s : band();
    if (as === 'year') return year() ?? s;
    if (as === 'prefix') return prefix();
    if (x !== null && !/^0\d/.test(s) && !(/^\d{5,}$/.test(s))) return band();
    if (/\d{1,4}[\/.-]\d{1,2}[\/.-]\d{1,4}|^\d{4}-\d{2}/.test(s)) { const y = year(); if (y) return y; }
    if (s.length <= 10 && /^[A-Za-z0-9 -]+$/.test(s)) return prefix();
    return s.split(/\s+/)[0];
  }
  const MASK_METHODS = { hash: 'Pseudonymize (keyed hash token)', partial: 'Partially hide (keep last characters)', redact: 'Redact ([REDACTED])', generalize: 'Generalize (year, age band, area code)', text: 'Redact personal data inside text', null: 'Remove values (set to null)' };

  /* ---------- Transform registry ---------- */
  // Steps never modify their input table. The server's chunked runs set inPlace (each chunk is used once and then
  // dropped), which skips copying every row for every step; the browser always copies.
  let inPlace = false;
  const clone = (t) => (inPlace ? { columns: [...t.columns], rows: t.rows } : { columns: [...t.columns], rows: t.rows.map(r => [...r]) });
  const setInPlace = (v) => { inPlace = !!v; };
  const targetCols = (t, cols) => (!cols || !cols.length || cols === '*') ? t.columns.map((_, i) => i) : [].concat(cols).map(c => colIndex(t, c));
  const py = (s) => JSON.stringify(s);
  const colList = (c) => !c || !c.length || c === '*' ? 'all columns' : [].concat(c).join(', ');
  const titleCase = (s) => s.toLowerCase().replace(/\b\w/g, c => c.toUpperCase());

  // A substring can keep its whole source text alive (V8 slices strings). Values that outlive their chunk (map keys,
  // samples) are copied, so a multi-GB file isn't retained through them. Short strings are copied by V8 anyway.
  const own = (v) => (typeof v === 'string' && v.length > 12 ? (' ' + v).slice(1) : v);
  const catKey = (s) => s.trim().toLowerCase().replace(/\s+/g, ' ').replace(/[.]/g, '');
  const FIT_MAX_DISTINCT = 2000000;
  const tooManyDistinct = (c) => `${c} has more than ${FIT_MAX_DISTINCT.toLocaleString('en-US')} distinct values, too many for this step on a large dataset.`;
  // Ops that need whole-column values (medians, category maps, bounds) are split into fit and apply, so the server
  // can fit over a whole file first and then apply chunk by chunk. In the browser both run on the full table.
  const fitAndApply = (op, t, p) => { const st = op.fitInit(t, p); op.fitAdd(st, t); return op.applyFit(t, p, op.fitDone(st)); };
  const targetColsPy = (c) => [].concat(c || []);

  /* ---------- AI training data: text helpers ---------- */
  // Steps that remove rows can say why, per row, to a removal ledger (the AI Data tab and server runs record one).
  // Off unless a ledger is being recorded.
  let reasonSink = null;
  const setReasonSink = (fn) => { reasonSink = fn || null; };
  const note = (row, reason, detail) => { if (reasonSink) reasonSink(row, reason, detail); }; // reason groups rows; detail is per row

  const textOf = (v) => (isNull(v) ? '' : typeof v === 'string' ? v : String(v));
  const WORD_RE = /[\p{L}\p{N}][\p{L}\p{N}\p{M}'’_-]*/gu;
  const wordsOf = (s) => s.match(WORD_RE) || [];
  const CJK_RE = /[぀-ヿ㐀-䶿一-鿿가-힯฀-๿]/g, CJK_ANY = /[぀-ヿ㐀-䶿一-鿿가-힯฀-๿]/;
  const cjkCount = (s) => (CJK_ANY.test(s) ? (s.match(CJK_RE) || []).length : 0);
  const isLetterTok = (w) => { for (let i = 0; i < w.length; i++) { const c = w.charCodeAt(i); if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122)) return true; if (c >= 0xC0 && /\p{L}/u.test(w[i])) return true; } return false; };
  // Rough token count (no tokenizer vocabulary ships offline): about 4 characters or 0.75 words per token for
  // alphabetic text, about 1.2 tokens per CJK or Thai character. Labelled "estimated" wherever it is shown.
  function estimateTokens(s) {
    if (!s) return 0;
    const cjk = cjkCount(s), rest = s.length - cjk, words = cjk ? wordsOf(s.replace(CJK_RE, ' ')).length : wordsOf(s).length;
    return Math.round(Math.max(rest / 4, words * 1.33) + cjk * 1.2);
  }
  function textLength(s, unit) { return unit === 'chars' ? [...s].length : unit === 'tokens' ? estimateTokens(s) : wordsOf(s).length; }

  // Reusable open-addressing table for counting n-grams (cleared by bumping a generation number, not by refilling).
  let GT = null;
  function gramTable(m) {
    let cap = 1024; while (cap < m * 2) cap *= 2;
    if (!GT || GT.ka.length < cap) GT = { ka: new Uint32Array(cap), kb: new Uint32Array(cap), cnt: new Int32Array(cap), gen: new Uint32Array(cap), g: 0, mask: cap - 1 };
    GT.mask = GT.ka.length - 1; if (++GT.g === 0xffffffff) { GT.gen.fill(0); GT.g = 1; }
    return GT;
  }
  // Document quality heuristics in the style of the Gopher and C4 filters. Returns the first failed check, or null.
  const BOILERPLATE = ['lorem ipsum', 'enable javascript', 'javascript is disabled', 'javascript is required', 'we use cookies', 'this website uses cookies', 'accept cookies', 'accept all cookies', 'cookie policy', 'all rights reserved', 'subscribe to our newsletter', 'sign up for our newsletter', 'click here to', 'page not found', '404 not found', 'access denied', 'terms of use', 'privacy policy'];
  const BOILER_RE = new RegExp(BOILERPLATE.map(b => b.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'));
  const QUALITY_PRESETS = {
    documents: { minWords: 50, maxWords: 100000, minMeanWord: 3, maxMeanWord: 10, maxSymbolRatio: 0.1, maxEllipsisLines: 0.3, minAlphaWords: 0.8, maxDupLines: 0.3, maxTopNgram: 0.2, maxBoilerLines: 0.3 },
    short: { minWords: 3, maxWords: 100000, minMeanWord: 1.5, maxMeanWord: 15, maxSymbolRatio: 0.25, maxEllipsisLines: 0.5, minAlphaWords: 0.6, maxDupLines: 0.5, maxTopNgram: 0.3, maxBoilerLines: 0.5 },
  };
  const QUALITY_REASONS = { empty: 'Empty text', too_short: 'Too few words', too_long: 'Too many words', boilerplate: 'Boilerplate (cookie, JavaScript or placeholder text)', not_alphabetic: 'Mostly numbers or symbols', word_length: 'Unusual word lengths (gibberish or run-together text)', symbols: 'Too many # or … symbols', ellipsis_lines: 'Too many truncated lines', repeated_lines: 'Repeated lines', repeated_ngrams: 'Repeated phrases' };
  function qualityThresholds(p) { const base = QUALITY_PRESETS[p.preset] || QUALITY_PRESETS.documents, o = { ...base }; for (const k of Object.keys(base)) if (p[k] !== undefined && p[k] !== null && p[k] !== '' && Number.isFinite(+p[k])) o[k] = +p[k]; return o; }
  function qualityIssue(text, th) {
    const s = text.trim(); if (!s) return 'empty';
    const words = wordsOf(s), cjk = cjkCount(s), cjkHeavy = cjk > s.length * 0.3;
    const wc = cjkHeavy ? Math.round(cjk / 1.5) + wordsOf(s.replace(CJK_RE, ' ')).length : words.length;
    if (wc < th.minWords) return 'too_short';
    if (wc > th.maxWords) return 'too_long';
    const lower = s.toLowerCase(), lines = s.split(/\n+/).map(l => l.trim()).filter(Boolean);
    if (lower.includes('lorem ipsum')) return 'boilerplate';
    const boilerLines = BOILER_RE.test(lower) ? lines.filter(l => BOILER_RE.test(l.toLowerCase())).length : 0;
    if (boilerLines && boilerLines / lines.length >= th.maxBoilerLines) return 'boilerplate';
    // Gopher's alphabetic-word rule counts whitespace-separated tokens, so "12,500" or "###" count as non-alphabetic.
    const toks = s.split(/\s+/).filter(Boolean);
    if (!cjkHeavy && toks.length) { let alpha = 0; for (const w of toks) if (isLetterTok(w)) alpha++; if (alpha / toks.length < th.minAlphaWords) return 'not_alphabetic'; }
    if (!cjkHeavy && words.length) { let len = 0; for (const w of words) len += w.length; const mean = len / words.length; if (mean < th.minMeanWord || mean > th.maxMeanWord) return 'word_length'; }
    const sym = (s.match(/#/g) || []).length + (s.match(/\.\.\.|…/g) || []).length;
    if (sym / Math.max(1, wc) > th.maxSymbolRatio) return 'symbols';
    if (lines.length >= 3 && lines.filter(l => /(\.\.\.|…)$/.test(l)).length / lines.length > th.maxEllipsisLines) return 'ellipsis_lines';
    if (lines.length >= 3) { const seen = new Set(); let dup = 0; for (const l of lines) { if (seen.has(l)) dup++; else seen.add(l); } if (dup / lines.length > th.maxDupLines) return 'repeated_lines'; }
    if (words.length >= 30) { // share of characters in the most repeated 2-, 3- and 4-word phrase
      const m = words.length, wh = new Uint32Array(m), wl = new Uint16Array(m); let total = 0;
      for (let i = 0; i < m; i++) { const w = words[i].toLowerCase(); wh[i] = strHash32(w, 0x2f6b); wl[i] = w.length; total += w.length; }
      for (const n of [2, 3, 4]) {
        const T = gramTable(m); let best = 0, bestAt = 0;
        for (let i = 0; i + n <= m; i++) {
          let a = 0x811c9dc5, b = n; for (let k = i; k < i + n; k++) { a = Math.imul(a ^ wh[k], 0x01000193); b = Math.imul(b + wh[k], 0x9e3779b1) ^ (b >>> 15); }
          a = mix32(a); b = b >>> 0;
          let j = a & T.mask; while (T.gen[j] === T.g && (T.ka[j] !== a || T.kb[j] !== b)) j = (j + 1) & T.mask;
          let c; if (T.gen[j] === T.g) c = ++T.cnt[j]; else { T.gen[j] = T.g; T.ka[j] = a; T.kb[j] = b; c = T.cnt[j] = 1; }
          if (c > best) { best = c; bestAt = i; }
        }
        let len = 0; for (let k = bestAt; k < bestAt + n; k++) len += wl[k];
        if (best > 1 && (best * len) / total > th.maxTopNgram - (n - 2) * 0.02) return 'repeated_ngrams';
      }
    }
    return null;
  }

  // Offline language identification: the writing system first, then common-word scoring for languages that share a
  // script. Covers 30 languages; returns 'und' when the text is too short or doesn't match any of them.
  const SCRIPTS = [['Latin', 0x41, 0x5A], ['Latin', 0x61, 0x7A], ['Latin', 0xC0, 0x24F], ['Latin', 0x1E00, 0x1EFF], ['Cyrillic', 0x400, 0x4FF], ['Greek', 0x370, 0x3FF], ['Armenian', 0x530, 0x58F], ['Hebrew', 0x590, 0x5FF], ['Arabic', 0x600, 0x6FF], ['Arabic', 0x750, 0x77F], ['Arabic', 0xFB50, 0xFDFF], ['Arabic', 0xFE70, 0xFEFF], ['Devanagari', 0x900, 0x97F], ['Bengali', 0x980, 0x9FF], ['Gurmukhi', 0xA00, 0xA7F], ['Gujarati', 0xA80, 0xAFF], ['Tamil', 0xB80, 0xBFF], ['Telugu', 0xC00, 0xC7F], ['Kannada', 0xC80, 0xCFF], ['Malayalam', 0xD00, 0xD7F], ['Sinhala', 0xD80, 0xDFF], ['Thai', 0xE00, 0xE7F], ['Lao', 0xE80, 0xEFF], ['Myanmar', 0x1000, 0x109F], ['Georgian', 0x10A0, 0x10FF], ['Ethiopic', 0x1200, 0x137F], ['Khmer', 0x1780, 0x17FF], ['Hangul', 0x1100, 0x11FF], ['Hangul', 0x3130, 0x318F], ['Hangul', 0xAC00, 0xD7AF], ['Kana', 0x3040, 0x30FF], ['Han', 0x3400, 0x4DBF], ['Han', 0x4E00, 0x9FFF]];
  const SCRIPT_LANG = { Greek: 'el', Armenian: 'hy', Hebrew: 'he', Bengali: 'bn', Gurmukhi: 'pa', Gujarati: 'gu', Tamil: 'ta', Telugu: 'te', Kannada: 'kn', Malayalam: 'ml', Sinhala: 'si', Thai: 'th', Lao: 'lo', Myanmar: 'my', Georgian: 'ka', Ethiopic: 'am', Khmer: 'km', Hangul: 'ko' };
  const STOP = {
    Latin: {
      en: 'the of and to in is that it for was on with as are be this by at not have from or but an they you his he she we which their were has had been will would there what all can a your our my its if about more other into than then them these those who when how just also any only after over out up one some get within i do me so no us',
      es: 'el la de que y en los se del las un por con una para es no al lo como más pero sus le ya o fue este ha sí porque esta son entre cuando muy sin sobre también me hasta hay donde',
      fr: 'le la les de des du et en un une est que qui dans pour pas sur au avec ce il elle ne se plus par sont mais ou nous vous leur cette été aux je sa son ses était',
      de: 'der die und in den von zu das mit sich des auf für ist im dem nicht ein eine als auch es an werden aus er hat dass sie nach wird bei einer um am sind noch wie einem über einen so zum war haben nur oder aber',
      pt: 'o a de que e do da em um para é com não uma os no se na por mais as dos como mas foi ao ele das tem à seu sua ou ser quando muito há nos já está também só pelo pela até isso',
      it: 'il di che e la per un in è una non con del le si da al i lo come più ma sono della dei anche ha nel alla gli questo se quando molto sua suo tra essere hanno era',
      nl: 'de het een van en in is dat op te zijn met voor niet aan er die maar om ook als dan bij nog uit door worden wordt heeft hij zij ze wij we naar of over deze kan',
      sv: 'och i att det som en på är av för med till den har de inte om ett han men var jag sig från vi så kan man när år säger hon under också efter eller nu sina',
      da: 'og i at det er en til på som de med han af for ikke der var mig sig men et har om vi min havde hun nu over da fra du ud sin dem os op',
      no: 'og i det som er en til på av for med han at ikke den har de var jeg seg men et om vi min hun nå over da fra du ut sin dem oss opp skal også eller',
      fi: 'ja on ei se että hän oli ovat mutta kun niin tai myös kuin joka jo nyt sen ole voi vain olla mukaan sekä hänen tämä mitä vielä ollut koska kanssa',
      pl: 'i w nie na się z do to że jest jak po co ale tak od za o dla jego już tylko przez są był może jej by lub być przy ich tym oraz',
      cs: 'a v se na je že to s z do o k i jako ale za by jsou pro od jeho není po tak které který jsem již být jen nebo také byl když',
      tr: 've bir bu da de için ile çok gibi daha ne ama olarak en kadar sonra her şey ben o var mı değil olan veya ise şu çünkü bunu',
      id: 'dan yang di ini itu dengan untuk tidak dari dalam akan pada juga ke ada bisa karena atau oleh mereka saya kami sudah telah lebih seperti tersebut',
      ro: 'și de la în a cu nu pe că o un este care se din mai ce pentru sau sunt fost au lui ei ca dar fi acest această prin',
      hu: 'a az és hogy nem is egy meg van de csak ez el már mint még kell volt ki ha vagy azt lesz mert minden sem amely nagyon',
      vi: 'và của là có không được cho trong một những người các với này đã để khi đến cũng như từ về thì nhưng ra làm',
    },
    Cyrillic: {
      ru: 'и в не на я что он с как а то это по но она к у же вы за бы из от так его все мы для только был о ее их или если',
      uk: 'і в не на що я з як це та він до але так у за від його є вона ми для ж ти були було також або її',
      bg: 'и на да се в не е за с че от по това са като но ще той тя ние ли беше',
      sr: 'и у је да на се не за са од то као али што ће био',
    },
    Arabic: { ar: 'في من على أن إلى عن هذا التي الذي مع كان ما لا هو هي ذلك كل قد بين', fa: 'و در به از که این را با است برای آن یک می شود بود تا هم کرد خود', ur: 'کے میں ہے کی اور سے کو یہ نے ہیں پر کہ ایک تھا بھی کر' },
    Devanagari: { hi: 'के है में की और से को का एक यह पर हैं भी नहीं कि था लिए ने', mr: 'आणि आहे या च्या की हे ते एक मध्ये होते त्या ला ने आहेत', ne: 'र छ को मा हो पनि गर्न भएको लागि यो छन् गरेको थियो' },
  };
  // Each word counts 1 / (number of languages in its script that use it), so words shared by many languages ("a",
  // "i", "do") weigh little and distinctive ones ("the", "und", "het") decide.
  // Per script: the languages, and one map word -> [language index, weight, ...] so each word is looked up once.
  const STOP_SETS = Object.fromEntries(Object.entries(STOP).map(([sc, langs]) => {
    const names = Object.keys(langs), users = new Map(), idx = new Map();
    for (const w of Object.values(langs)) for (const x of new Set(w.split(' '))) users.set(x, (users.get(x) || 0) + 1);
    names.forEach((l, li) => { for (const x of new Set(langs[l].split(' '))) { const e = idx.get(x) || []; e.push(li, 1 / users.get(x)); idx.set(x, e); } });
    return [sc, { names, idx }];
  }));
  const MARKERS = [['es', /[ñ¿¡]/g], ['pt', /[ãõ]/g], ['de', /ß/g], ['pl', /[łąęśźżń]/g], ['cs', /[řěů]/g], ['tr', /[ğış]/g], ['ro', /[șțşţă]/g], ['hu', /[őű]/g], ['vi', /[ơưđẠ-ỹ]/g], ['da', /[æø]/g], ['no', /[æø]/g]];
  const LANGUAGES = { und: 'Undetermined', en: 'English', es: 'Spanish', fr: 'French', de: 'German', pt: 'Portuguese', it: 'Italian', nl: 'Dutch', sv: 'Swedish', da: 'Danish', no: 'Norwegian', fi: 'Finnish', pl: 'Polish', cs: 'Czech', tr: 'Turkish', id: 'Indonesian', ro: 'Romanian', hu: 'Hungarian', vi: 'Vietnamese', ru: 'Russian', uk: 'Ukrainian', bg: 'Bulgarian', sr: 'Serbian', ar: 'Arabic', fa: 'Persian', ur: 'Urdu', hi: 'Hindi', mr: 'Marathi', ne: 'Nepali', el: 'Greek', hy: 'Armenian', he: 'Hebrew', bn: 'Bengali', pa: 'Punjabi', gu: 'Gujarati', ta: 'Tamil', te: 'Telugu', kn: 'Kannada', ml: 'Malayalam', si: 'Sinhala', th: 'Thai', lo: 'Lao', my: 'Burmese', ka: 'Georgian', am: 'Amharic', km: 'Khmer', ko: 'Korean', ja: 'Japanese', zh: 'Chinese' };
  function scriptOf(cp) { for (const [n, a, b] of SCRIPTS) if (cp >= a && cp <= b) return n; return null; }
  function detectLanguage(text) {
    const s = text.length > 1000 ? text.slice(0, 1000) : text, counts = {}; let letters = 0, latin = 0; // the opening is enough to tell
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      if (c < 0x80) { if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122)) { latin++; letters++; } continue; }
      if (c >= 0xDC00 && c <= 0xDFFF) continue;
      const sc = scriptOf(c >= 0xD800 && c <= 0xDBFF ? s.codePointAt(i) : c); if (sc) { counts[sc] = (counts[sc] || 0) + 1; letters++; }
    }
    if (latin) counts.Latin = (counts.Latin || 0) + latin;
    if (letters < 10) return { lang: 'und', score: 0 };
    const top = Object.entries(counts).sort((a, b) => b[1] - a[1])[0], share = top[1] / letters;
    if (top[0] === 'Kana' || top[0] === 'Han') { const kana = counts.Kana || 0, han = counts.Han || 0; return { lang: kana > 0.1 * (kana + han) ? 'ja' : 'zh', score: +((kana + han) / letters).toFixed(2) }; }
    if (SCRIPT_LANG[top[0]]) return { lang: SCRIPT_LANG[top[0]], score: +share.toFixed(2) };
    const sets = STOP_SETS[top[0]]; if (!sets) return { lang: 'und', score: 0 };
    const words = wordsOf(s.toLowerCase()); if (words.length < 5) return { lang: 'und', score: 0 };
    const score = new Float64Array(sets.names.length);
    for (const w of words) { const e = sets.idx.get(w); if (e) for (let k = 0; k < e.length; k += 2) score[e[k]] += e[k + 1]; }
    const hits = sets.names.map((l, i) => [l, score[i]]);
    if (top[0] === 'Latin') { const low = s.toLowerCase(); for (const [l, re] of MARKERS) { const m = (low.match(re) || []).length; if (m) { const e = hits.find(x => x[0] === l); e[1] += Math.min(m * 0.5, words.length * 0.1); } } }
    hits.sort((a, b) => b[1] - a[1]);
    const [best, second] = hits; if (best[1] < 0.75) return { lang: 'und', score: 0 };
    const coverage = best[1] / words.length, margin = (best[1] - second[1]) / best[1];
    return { lang: best[0], score: +Math.min(1, (coverage / 0.25) * (0.5 + 0.5 * margin) * share).toFixed(2) };
  }

  // Near-duplicate detection: MinHash signatures (one-permutation hashing with densification, 100 bins over word
  // 5-gram shingles) and locality-sensitive hashing (20 bands of 5 bins). Candidates are confirmed by comparing
  // signatures, so unrelated texts that happen to share a band are not removed. The index keeps, per kept text,
  // 20 band keys and a 100-byte signature in typed arrays.
  const MH_K = 100, MH_B = 20, MH_R = 5;
  function mix32(h) { h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b); h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35); h ^= h >>> 16; return h >>> 0; }
  function strHash32(s, seed) { let h = seed | 0; for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193); return mix32(h ^ s.length); }
  function normText(s) { return s.normalize('NFKC').toLowerCase().replace(/[\p{P}\p{S}]+/gu, ' ').replace(/\s+/g, ' ').trim(); }
  function minhash(norm, n) {
    const words = norm.split(' '), th = new Uint32Array(words.length); for (let i = 0; i < words.length; i++) th[i] = strHash32(words[i], 0x9747b28c);
    const sig = new Uint32Array(MH_K).fill(0xffffffff), filled = new Uint8Array(MH_K), m = Math.max(1, th.length - n + 1);
    for (let i = 0; i < m; i++) {
      let h = 0x2545f491; const e = Math.min(th.length, i + n);
      for (let k = i; k < e; k++) h = mix32(Math.imul(h, 0x9e3779b1) ^ th[k]);
      const bin = Math.floor(h * MH_K / 4294967296), v = mix32(h ^ 0x5bd1e995);
      if (v < sig[bin] || !filled[bin]) { sig[bin] = v; filled[bin] = 1; }
    }
    for (let j = 0; j < MH_K; j++) if (!filled[j]) { let d = 1; while (!filled[(j + d) % MH_K]) d++; sig[j] = mix32(sig[(j + d) % MH_K] + Math.imul(d, 0x9e3779b9)); }
    return sig;
  }
  class U32Map { // open addressing: uint32 key -> int32 value (first value wins)
    constructor(cap = 1 << 12) { this.k = new Uint32Array(cap); this.v = new Int32Array(cap); this.used = new Uint8Array(cap); this.n = 0; }
    get(key) { const m = this.k.length - 1; let i = mix32(key) & m; while (this.used[i]) { if (this.k[i] === key) return this.v[i]; i = (i + 1) & m; } return -1; }
    setIfAbsent(key, val) {
      if ((this.n + 1) * 10 > this.k.length * 7) this.grow();
      const m = this.k.length - 1; let i = mix32(key) & m;
      while (this.used[i]) { if (this.k[i] === key) return false; i = (i + 1) & m; }
      this.used[i] = 1; this.k[i] = key; this.v[i] = val; this.n++; return true;
    }
    grow() { const { k, v, used } = this; this.k = new Uint32Array(k.length * 2); this.v = new Int32Array(k.length * 2); this.used = new Uint8Array(k.length * 2); this.n = 0; for (let i = 0; i < k.length; i++) if (used[i]) this.setIfAbsent(k[i], v[i]); }
  }
  const NEAR_MAX_DOCS = 20000000;
  class NearDupIndex {
    constructor(opts = {}) { this.th = opts.threshold ?? 0.8; this.n = opts.ngram || 5; this.count = 0; this.sigs = new Uint8Array(MH_K * 4096); this.rowOf = new Float64Array(4096); this.bands = Array.from({ length: MH_B }, () => new U32Map()); this.exact = new U32Map(); this.exact2 = []; this.max = opts.maxDocs || NEAR_MAX_DOCS; }
    /** Returns null (new text, now indexed), or { row, sim, exact } for the earlier text it duplicates. */
    check(text, rowNo) {
      const norm = normText(text); if (!norm) return null;
      const [a, b] = hash2(norm), prev = this.exactGet(a, b);
      if (prev >= 0) return { row: this.rowOf[prev], sim: 1, exact: true };
      const sig = minhash(norm, this.n), keys = new Uint32Array(MH_B);
      let best = -1, bestSim = 0;
      for (let band = 0; band < MH_B; band++) {
        let h = Math.imul(band + 1, 0x9e3779b1); for (let r = 0; r < MH_R; r++) h = mix32(h ^ sig[band * MH_R + r]);
        keys[band] = h;
        const d = this.bands[band].get(h);
        if (d >= 0 && d !== best) { const sim = this.similarity(sig, d); if (sim >= this.th && sim > bestSim) { best = d; bestSim = sim; } }
      }
      if (best >= 0) return { row: this.rowOf[best], sim: +bestSim.toFixed(3), exact: false };
      if (this.count >= this.max) throw new Error(`Near-duplicate removal is limited to ${this.max.toLocaleString('en-US')} unique texts per run.`);
      const id = this.count++;
      if (id >= this.rowOf.length) { const r = new Float64Array(this.rowOf.length * 2); r.set(this.rowOf); this.rowOf = r; const s = new Uint8Array(this.sigs.length * 2); s.set(this.sigs); this.sigs = s; }
      this.rowOf[id] = rowNo; for (let k = 0; k < MH_K; k++) this.sigs[id * MH_K + k] = sig[k] & 255;
      for (let band = 0; band < MH_B; band++) this.bands[band].setIfAbsent(keys[band], id);
      this.exactSet(a, b, id);
      return null;
    }
    similarity(sig, d) { let eq = 0; const off = d * MH_K; for (let k = 0; k < MH_K; k++) if ((sig[k] & 255) === this.sigs[off + k]) eq++; return Math.max(0, (eq / MH_K - 1 / 256) / (1 - 1 / 256)); }
    exactGet(a, b) { const id = this.exact.get(a >>> 0); if (id < 0) return -1; if (this.exact2[id] === (b >>> 0)) return id; for (const [x, y] of this.extra || []) if (x === (a >>> 0) && this.exact2[y] === (b >>> 0)) return y; return -1; }
    exactSet(a, b, id) { this.exact2[id] = b >>> 0; if (!this.exact.setIfAbsent(a >>> 0, id)) (this.extra || (this.extra = [])).push([a >>> 0, id]); }
  }

  // Contamination check: which evaluation texts also appear in the training data, exactly (after normalising case,
  // punctuation and spacing) or through a shared 13-word sequence (the overlap test used for GPT-3's benchmarks).
  // Built from the evaluation side, so the training data can be streamed through in chunks.
  // n-gram keys: two independent rolling polynomial hashes over word hashes, packed into one 53-bit number.
  const P1 = 0x01000193, P2 = 0x5bd1e995;
  function gramKeys(norm, n, each) {
    const w = norm.split(' '), m = w.length, h = new Uint32Array(m); for (let i = 0; i < m; i++) h[i] = strHash32(w[i], 0x1b873593);
    const len = Math.min(n, m); let a = 0, b = 0, pa = 1, pb = 1;
    for (let k = 0; k < len; k++) { a = (Math.imul(a, P1) + h[k]) >>> 0; b = (Math.imul(b, P2) + h[k]) >>> 0; if (k) { pa = Math.imul(pa, P1); pb = Math.imul(pb, P2); } }
    each((a >>> 11) * 4294967296 + (b >>> 0) + len);
    for (let s = 1; s + n <= m; s++) {
      a = (Math.imul((a - Math.imul(h[s - 1], pa)) >>> 0, P1) + h[s + n - 1]) >>> 0; b = (Math.imul((b - Math.imul(h[s - 1], pb)) >>> 0, P2) + h[s + n - 1]) >>> 0;
      each((a >>> 11) * 4294967296 + (b >>> 0) + len);
    }
  }
  const textKey = (norm) => { const [a, b] = hash2(norm); return (a >>> 11) * 4294967296 + (b >>> 0); };
  function createContamination(evalTexts, opts = {}) {
    const n = opts.ngram || 13, exact = new Map(), grams = new Map(), info = evalTexts.map(() => ({ exact: false, hits: 0, grams: 0, trainRow: -1 }));
    evalTexts.forEach((t, i) => {
      const norm = normText(textOf(t)); if (!norm) return;
      const k = textKey(norm); if (!exact.has(k)) exact.set(k, []); exact.get(k).push(i);
      const keys = new Set(); gramKeys(norm, n, (g) => keys.add(g));
      info[i].grams = keys.size;
      for (const g of keys) { const l = grams.get(g); if (l) { if (!l.includes(i)) l.push(i); } else grams.set(g, [i]); }
    });
    let trainRows = 0;
    return {
      add(trainTexts) {
        for (const t of trainTexts) {
          const row = trainRows++, norm = normText(textOf(t)); if (!norm) continue;
          const ex = exact.get(textKey(norm)); if (ex) for (const i of ex) { info[i].exact = true; if (info[i].trainRow < 0) info[i].trainRow = row; }
          let seen = null;
          gramKeys(norm, n, (g) => {
            const hit = grams.get(g); if (!hit) return;
            seen = seen || new Set();
            for (const i of hit) { const k = i + ':' + g; if (seen.has(k)) continue; seen.add(k); info[i].hits++; if (info[i].trainRow < 0) info[i].trainRow = row; }
          });
        }
      },
      finish() {
        const rows = info.map((x, i) => ({ index: i, exact: x.exact, overlap: x.grams ? Math.min(1, x.hits / x.grams) : 0, trainRow: x.trainRow })).filter(x => x.exact || x.overlap > 0);
        return { evalRows: evalTexts.length, trainRows, ngram: n, contaminated: rows.length, exact: rows.filter(x => x.exact).length, rows };
      },
    };
  }
  const contamination = (trainTexts, evalTexts, opts) => { const c = createContamination(evalTexts, opts); c.add(trainTexts); return c.finish(); };

  const REDACT_KINDS = ['email', 'phone', 'card', 'ssn', 'iban', 'ipv4'];
  function redactText(s, kinds, style) {
    let v = s;
    for (const [kind, re, rep, ok] of TEXT_PII) {
      if (kinds && !kinds.includes(kind)) continue;
      const tag = style === 'tokens' ? `<|${kind === 'ipv4' ? 'ip' : kind}|>` : rep;
      re.lastIndex = 0; v = v.replace(re, (m) => (!ok || ok(m) ? tag : m));
    }
    return v;
  }
  const splitBucket = (key, seed) => { const [a] = hash2((seed || '') + '\u0000' + key); return (a >>> 0) / 4294967296; };
  const uniqueName = (t, name) => { let n = name, i = 2; while (t.columns.includes(n)) n = `${name}_${i++}`; return n; };

  const OPS = {
    standardize_nulls: {
      label: 'Standardize null tokens', group: 'Clean', params: [{ k: 'columns', t: 'columns', label: 'Columns (empty = all)' }],
      apply(t, p) { const o = clone(t); let n = 0; for (const ci of targetCols(o, p.columns)) for (const r of o.rows) if (typeof r[ci] === 'string' && r[ci] !== '' && isNull(r[ci])) { r[ci] = ''; n++; } return { table: o, affected: n }; },
      describe: (p) => `Convert "N/A", "null", "-" etc. to nulls in ${colList(p.columns)}`,
      pandas: (p) => `df${p.columns && p.columns.length ? '[' + py([].concat(p.columns)) + ']' : ''} = df${p.columns && p.columns.length ? '[' + py([].concat(p.columns)) + ']' : ''}.replace(${py(['N/A', 'NA', 'null', 'NULL', 'None', '-', '?', 'nan'])}, pd.NA)`
    },
    trim: {
      label: 'Trim whitespace', group: 'Clean', params: [{ k: 'columns', t: 'columns', label: 'Columns (empty = all)' }],
      apply(t, p) { const o = clone(t); let n = 0; for (const ci of targetCols(o, p.columns)) for (const r of o.rows) if (typeof r[ci] === 'string') { const v = r[ci].trim().replace(/\s{2,}/g, ' '); if (v !== r[ci]) { r[ci] = v; n++; } } return { table: o, affected: n }; },
      describe: (p) => `Trim and collapse whitespace in ${colList(p.columns)}`,
      pandas: (p) => p.columns && p.columns.length ? [].concat(p.columns).map(c => `df[${py(c)}] = df[${py(c)}].astype("string").str.strip().str.replace(r"\\s+", " ", regex=True)`).join('\n') : `df = df.apply(lambda s: s.str.strip().str.replace(r"\\s+", " ", regex=True) if s.dtype == "object" else s)`
    },
    case: {
      label: 'Change case', group: 'Clean', params: [{ k: 'columns', t: 'columns', label: 'Columns' }, { k: 'mode', t: 'select', options: ['lower', 'upper', 'title'], label: 'Case' }],
      apply(t, p) { const o = clone(t); let n = 0; const f = { lower: s => s.toLowerCase(), upper: s => s.toUpperCase(), title: titleCase }[p.mode || 'lower']; for (const ci of targetCols(o, p.columns)) for (const r of o.rows) if (typeof r[ci] === 'string' && !isNull(r[ci])) { const v = f(r[ci]); if (v !== r[ci]) { r[ci] = v; n++; } } return { table: o, affected: n }; },
      describe: (p) => `Convert ${colList(p.columns)} to ${p.mode || 'lower'} case`,
      pandas: (p) => [].concat(p.columns).map(c => `df[${py(c)}] = df[${py(c)}].str.${p.mode || 'lower'}()`).join('\n')
    },
    standardize_categories: {
      label: 'Merge category variants', group: 'Clean', params: [{ k: 'columns', t: 'columns', label: 'Columns' }],
      apply(t, p) { return fitAndApply(this, t, p); },
      fitInit(t, p) { const cols = targetCols(t, p.columns); return { cols, freq: cols.map(() => new Map()) }; },
      fitAdd(st, t) { st.cols.forEach((ci, k) => { const m = st.freq[k]; for (const r of t.rows) if (!isNull(r[ci])) { const v = String(r[ci]), c = m.get(v); m.set(c === undefined ? own(v) : v, (c || 0) + 1); } if (m.size > FIT_MAX_DISTINCT) throw new Error(tooManyDistinct(t.columns[ci])); }); },
      fitDone(st) {
        const nice = (v) => { const s = v.trim(); if (s.length <= 4 && s === s.toUpperCase()) return 3; if (s === titleCase(s)) return 2; if (/^[A-Z]/.test(s) && s !== s.toUpperCase()) return 1; return 0; };
        return { canon: st.freq.map(freq => {
          const byKey = new Map(), canon = new Map();
          for (const [v, c] of freq.entries()) { const k = catKey(v); const s = v.trim().replace(/\s+/g, ' '); const cur = byKey.get(k); const score = nice(s) * 1e9 + c; if (!cur || score > cur.score) byKey.set(k, { s, score }); }
          for (const [k, v] of byKey) canon.set(k, v.s);
          return canon;
        }) };
      },
      applyFit(t, p, f) {
        const o = clone(t); let n = 0;
        targetCols(o, p.columns).forEach((ci, k) => { const canon = f.canon[k]; for (const r of o.rows) if (!isNull(r[ci])) { const v = canon.get(catKey(String(r[ci]))); if (v !== r[ci]) { r[ci] = v; n++; } } });
        return { table: o, affected: n };
      },
      describe: (p) => `Merge case/spacing variants into the most frequent spelling in ${colList(p.columns)}`,
      pandas: (p) => [].concat(p.columns).map(c => `_k = df[${py(c)}].str.strip().str.lower().str.replace(r"\\s+", " ", regex=True)\ndf[${py(c)}] = _k.map(df.groupby(_k)[${py(c)}].agg(lambda s: s.value_counts().index[0]))`).join('\n')
    },
    fill_null: {
      label: 'Fill missing values', group: 'Clean', params: [{ k: 'columns', t: 'columns', label: 'Columns' }, { k: 'strategy', t: 'select', options: ['median', 'mean', 'mode', 'constant', 'ffill', 'bfill'], label: 'Strategy' }, { k: 'value', t: 'text', label: 'Constant value' }, { k: 'groupBy', t: 'column', label: 'Group by (optional)', optional: true }],
      apply(t, p) {
        const s = p.strategy || 'median';
        if (s === 'ffill') return this.applyChunk(t, p, {});
        if (s === 'bfill') {
          const o = clone(t); let n = 0; if (p.groupBy) colIndex(o, p.groupBy);
          for (const ci of targetCols(o, p.columns)) { let last = null; for (let i = o.rows.length - 1; i >= 0; i--) { const r = o.rows[i]; if (isNull(r[ci])) { if (last !== null) { r[ci] = last; n++; } } else last = r[ci]; } }
          return { table: o, affected: n };
        }
        if (s === 'constant') {
          const o = clone(t); let n = 0; if (p.groupBy) colIndex(o, p.groupBy); const v = p.value ?? '';
          for (const ci of targetCols(o, p.columns)) for (const r of o.rows) if (isNull(r[ci])) { r[ci] = v; n++; }
          return { table: o, affected: n };
        }
        return fitAndApply(this, t, p); // median / mean / mode, optionally per group
      },
      applyChunk(t, p, st) { // ffill: the last value carries over to the next chunk
        const o = clone(t); let n = 0; if (p.groupBy) colIndex(o, p.groupBy); st.last = st.last || {};
        for (const ci of targetCols(o, p.columns)) { let last = st.last[ci] ?? null; for (const r of o.rows) { if (isNull(r[ci])) { if (last !== null) { r[ci] = last; n++; } } else last = r[ci]; } st.last[ci] = last; }
        return { table: o, affected: n };
      },
      fitInit(t, p) { const cols = targetCols(t, p.columns); return { cols, gi: p.groupBy ? colIndex(t, p.groupBy) : -1, s: p.strategy || 'median', acc: cols.map(() => new Map()) }; },
      fitAdd(st, t) {
        const mode = st.s === 'mode';
        for (const r of t.rows) {
          const g = st.gi >= 0 ? String(r[st.gi]) : '*';
          for (let k = 0; k < st.cols.length; k++) {
            const v = r[st.cols[k]]; if (isNull(v)) continue;
            let c = st.acc[k].get(g); if (!c) st.acc[k].set(own(g), c = mode ? new Map() : new NumBuf());
            if (mode) { const key = String(v), n = c.get(key); c.set(n === undefined ? own(key) : key, (n || 0) + 1); } else { const x = looseNumber(v); if (x !== null) c.push(x); }
          }
        }
      },
      fitDone(st) {
        return { fills: st.acc.map(m => { const out = new Map(); for (const [g, c] of m) {
          if (st.s === 'mode') { const top = topOf(c, 1)[0]; out.set(g, top ? top.value : null); continue; }
          const ns = numStatsSorted(c.sorted()); out.set(g, ns ? Math.round((st.s === 'mean' ? ns.mean : ns.median) * 1e6) / 1e6 : null);
        } return out; }) };
      },
      applyFit(t, p, f) {
        const o = clone(t); let n = 0; const gi = p.groupBy ? colIndex(o, p.groupBy) : -1;
        targetCols(o, p.columns).forEach((ci, k) => { const fills = f.fills[k]; for (const r of o.rows) if (isNull(r[ci])) { const v = fills.get(gi >= 0 ? String(r[gi]) : '*'); if (v !== undefined && v !== null) { r[ci] = v; n++; } } });
        return { table: o, affected: n };
      },
      describe: (p) => `Fill missing ${colList(p.columns)} with ${p.strategy === 'constant' ? '"' + p.value + '"' : p.strategy || 'median'}${p.groupBy ? ' by ' + p.groupBy : ''}`,
      pandas: (p) => [].concat(p.columns).map(c => {
        const s = p.strategy || 'median';
        if (s === 'ffill' || s === 'bfill') return `df[${py(c)}] = df[${py(c)}].${s}()`;
        if (s === 'constant') return `df[${py(c)}] = df[${py(c)}].fillna(${py(p.value)})`;
        if (p.groupBy) return `df[${py(c)}] = df[${py(c)}].fillna(df.groupby(${py(p.groupBy)})[${py(c)}].transform(${s === 'mode' ? 'lambda s: s.mode().iloc[0] if not s.mode().empty else None' : py(s)}))`;
        return `df[${py(c)}] = df[${py(c)}].fillna(df[${py(c)}].${s}()${s === 'mode' ? '.iloc[0]' : ''})`;
      }).join('\n')
    },
    drop_null_rows: {
      label: 'Drop rows with missing values', group: 'Clean', params: [{ k: 'columns', t: 'columns', label: 'Columns (empty = any)' }],
      apply(t, p) { const o = clone(t); const cs = targetCols(o, p.columns); const before = o.rows.length; o.rows = o.rows.filter(r => { const ci = cs.find(i => isNull(r[i])); if (ci === undefined) return true; note(r, `Missing ${o.columns[ci]}`); return false; }); return { table: o, affected: before - o.rows.length }; },
      describe: (p) => `Drop rows missing ${colList(p.columns)}`,
      pandas: (p) => `df = df.dropna(${p.columns && p.columns.length ? 'subset=' + py([].concat(p.columns)) : ''})`
    },
    drop_duplicates: {
      label: 'Remove duplicate rows', group: 'Clean', params: [{ k: 'columns', t: 'columns', label: 'Key columns (empty = all)' }, { k: 'keep', t: 'select', options: ['first', 'last'], label: 'Keep' }],
      apply(t, p) {
        const o = clone(t); const cs = p.columns && p.columns.length ? targetCols(o, p.columns) : null; const seen = new Set(); const before = o.rows.length;
        const rows = p.keep === 'last' ? [...o.rows].reverse() : o.rows;
        let kept = rows.filter(r => { const k = JSON.stringify(cs ? cs.map(i => r[i]) : r); if (seen.has(k)) { note(r, cs ? 'Duplicate key' : 'Duplicate row'); return false; } seen.add(k); return true; });
        if (p.keep === 'last') kept = kept.reverse();
        o.rows = kept; return { table: o, affected: before - kept.length };
      },
      applyChunk(t, p, st) { // keep first, across chunks: a hash set instead of a Set of row strings (millions of rows)
        const o = clone(t); const cs = p.columns && p.columns.length ? targetCols(o, p.columns) : null; const before = o.rows.length;
        st.seen = st.seen || new RowHashSet(1 << 20);
        o.rows = o.rows.filter(r => { if (st.seen.addRow(cs ? cs.map(i => r[i]) : r)) return true; note(r, cs ? 'Duplicate key' : 'Duplicate row'); return false; });
        return { table: o, affected: before - o.rows.length };
      },
      describe: (p) => p.columns && p.columns.length ? `Remove duplicates on ${colList(p.columns)} (keep ${p.keep || 'first'})` : 'Remove exact duplicate rows',
      pandas: (p) => `df = df.drop_duplicates(${p.columns && p.columns.length ? 'subset=' + py([].concat(p.columns)) + ', ' : ''}keep=${py(p.keep || 'first')})`
    },
    clean_numeric: {
      label: 'Parse numbers from text', group: 'Clean', params: [{ k: 'columns', t: 'columns', label: 'Columns' }],
      apply(t, p) { const o = clone(t); let n = 0; for (const ci of targetCols(o, p.columns)) for (const r of o.rows) { if (isNull(r[ci])) continue; const v = looseNumber(r[ci]); const nv = v === null ? '' : v; if (nv !== r[ci]) { r[ci] = nv; n++; } } return { table: o, affected: n }; },
      describe: (p) => `Strip currency, commas and % and convert ${colList(p.columns)} to numbers`,
      pandas: (p) => [].concat(p.columns).map(c => `df[${py(c)}] = pd.to_numeric(df[${py(c)}].astype("string").str.replace(r"[$€£,\\s]", "", regex=True).str.rstrip("%"), errors="coerce")`).join('\n')
    },
    parse_dates: {
      label: 'Parse dates to ISO 8601', group: 'Clean', params: [{ k: 'columns', t: 'columns', label: 'Columns' }, { k: 'dayFirst', t: 'bool', label: 'Day first when ambiguous' }],
      apply(t, p) { const o = clone(t); let n = 0; for (const ci of targetCols(o, p.columns)) for (const r of o.rows) { if (isNull(r[ci])) continue; const v = parseDate(r[ci], !!p.dayFirst); const nv = v === null ? '' : v; if (nv !== r[ci]) { r[ci] = nv; n++; } } return { table: o, affected: n }; },
      describe: (p) => `Parse ${colList(p.columns)} as dates (ISO 8601${p.dayFirst ? ', day-first' : ''})`,
      pandas: (p) => [].concat(p.columns).map(c => `df[${py(c)}] = pd.to_datetime(df[${py(c)}], errors="coerce", format="mixed"${p.dayFirst ? ', dayfirst=True' : ''})`).join('\n')
    },
    cast: {
      label: 'Change column type', group: 'Transform', params: [{ k: 'columns', t: 'columns', label: 'Columns' }, { k: 'to', t: 'select', options: ['number', 'integer', 'string', 'boolean', 'date'], label: 'Type' }],
      apply(t, p) {
        const o = clone(t); let n = 0;
        const f = { number: v => looseNumber(v), integer: v => { const x = looseNumber(v); return x === null ? null : Math.round(x); }, string: v => String(v), boolean: toBool, date: v => parseDate(v) }[p.to];
        for (const ci of targetCols(o, p.columns)) for (const r of o.rows) { if (isNull(r[ci])) continue; const v = f(r[ci]); const nv = v === null ? '' : v; if (nv !== r[ci]) { r[ci] = nv; n++; } }
        return { table: o, affected: n };
      },
      describe: (p) => `Cast ${colList(p.columns)} to ${p.to}`,
      pandas: (p) => [].concat(p.columns).map(c => ({ number: `df[${py(c)}] = pd.to_numeric(df[${py(c)}], errors="coerce")`, integer: `df[${py(c)}] = pd.to_numeric(df[${py(c)}], errors="coerce").round().astype("Int64")`, string: `df[${py(c)}] = df[${py(c)}].astype("string")`, boolean: `df[${py(c)}] = df[${py(c)}].astype("string").str.lower().map({"true": True, "yes": True, "y": True, "1": True, "false": False, "no": False, "n": False, "0": False})`, date: `df[${py(c)}] = pd.to_datetime(df[${py(c)}], errors="coerce", format="mixed")` })[p.to]).join('\n')
    },
    range_check: {
      label: 'Enforce allowed range', group: 'Clean',
      params: [{ k: 'column', t: 'column', label: 'Column' }, { k: 'min', t: 'number', label: 'Minimum (empty = no minimum)' }, { k: 'max', t: 'number', label: 'Maximum (empty = no maximum)' }, { k: 'action', t: 'select', options: ['null', 'flag', 'cap', 'remove'], labels: { null: 'Blank them out (fill later)', flag: 'Flag them in a new column', cap: 'Cap them at the limit', remove: 'Remove those rows' }, label: 'Values outside the range' }],
      apply(t, p) {
        const hasMin = p.min !== undefined && p.min !== null && p.min !== '', hasMax = p.max !== undefined && p.max !== null && p.max !== '';
        if (!hasMin && !hasMax) throw new Error('Set a minimum, a maximum, or both.');
        if (hasMin && hasMax && +p.min > +p.max) throw new Error('The minimum is larger than the maximum.');
        const o = clone(t), ci = colIndex(o, p.column), action = p.action || 'null';
        const isOut = (r) => { const x = looseNumber(r[ci]); return x !== null && !inRange(x, hasMin ? p.min : null, hasMax ? p.max : null); };
        let n = 0;
        if (action === 'remove') { const b = o.rows.length; o.rows = o.rows.filter(r => { if (!isOut(r)) return true; note(r, `${p.column} outside ${rangeText(p.min, p.max)}`); return false; }); n = b - o.rows.length; }
        else if (action === 'flag') { o.columns.push(p.column + '_out_of_range'); for (const r of o.rows) { const f = isOut(r); r.push(f); if (f) n++; } }
        else for (const r of o.rows) if (isOut(r)) { const x = looseNumber(r[ci]); r[ci] = action === 'cap' ? Math.min(hasMax ? +p.max : Infinity, Math.max(hasMin ? +p.min : -Infinity, x)) : ''; n++; }
        return { table: o, affected: n };
      },
      describe: (p) => `${{ null: 'Blank out', flag: 'Flag', cap: 'Cap', remove: 'Remove rows with' }[p.action || 'null']} ${p.column} values outside ${rangeText(p.min, p.max)}`,
      pandas: (p) => {
        const c = py(p.column), has = (v) => v !== undefined && v !== null && v !== '';
        const lo = has(p.min) ? +p.min : null, hi = has(p.max) ? +p.max : null;
        const cond = [lo !== null ? `(df[${c}] < ${lo})` : null, hi !== null ? `(df[${c}] > ${hi})` : null].filter(Boolean).join(' | ');
        const clip = `df[${c}] = df[${c}].clip(${lo !== null ? 'lower=' + lo : ''}${lo !== null && hi !== null ? ', ' : ''}${hi !== null ? 'upper=' + hi : ''})`;
        return { null: `df.loc[${cond}, ${c}] = pd.NA`, flag: `df[${py(p.column + '_out_of_range')}] = ${cond}`, cap: clip, remove: `df = df[~(${cond})]` }[p.action || 'null'];
      }
    },
    outliers: {
      label: 'Handle outliers', group: 'Clean', params: [{ k: 'column', t: 'column', label: 'Column' }, { k: 'method', t: 'select', options: ['iqr', 'zscore'], label: 'Method' }, { k: 'threshold', t: 'number', label: 'Threshold (IQR × k or |z|)' }, { k: 'action', t: 'select', options: ['remove', 'cap', 'flag'], label: 'Action' }],
      apply(t, p) { return fitAndApply(this, t, p); },
      fitInit(t, p) { return { ci: colIndex(t, p.column), buf: new NumBuf(), p }; },
      fitAdd(st, t) { for (const r of t.rows) { const x = looseNumber(r[st.ci]); if (x !== null) st.buf.push(x); } },
      fitDone(st) {
        const ns = numStatsSorted(st.buf.sorted()); if (!ns) return null; const p = st.p;
        const k = +p.threshold || (p.method === 'zscore' ? 3 : 1.5);
        return p.method === 'zscore' ? { lo: ns.mean - k * ns.std, hi: ns.mean + k * ns.std } : { lo: ns.q1 - k * ns.iqr, hi: ns.q3 + k * ns.iqr };
      },
      applyFit(t, p, f) {
        const o = clone(t); const ci = colIndex(o, p.column); if (!f) return { table: o, affected: 0 };
        const { lo, hi } = f;
        const isOut = (r) => { const x = looseNumber(r[ci]); return x !== null && (x < lo || x > hi); };
        let n = 0;
        if (p.action === 'remove') { const b = o.rows.length; o.rows = o.rows.filter(r => { if (!isOut(r)) return true; note(r, `Outlier in ${p.column}`); return false; }); n = b - o.rows.length; }
        else if (p.action === 'cap') { for (const r of o.rows) if (isOut(r)) { r[ci] = Math.min(hi, Math.max(lo, looseNumber(r[ci]))); r[ci] = Math.round(r[ci] * 1e6) / 1e6; n++; } }
        else { o.columns.push(p.column + '_outlier'); for (const r of o.rows) { const f = isOut(r); r.push(f); if (f) n++; } }
        return { table: o, affected: n };
      },
      describe: (p) => `${{ remove: 'Remove', cap: 'Cap', flag: 'Flag' }[p.action || 'remove']} outliers in ${p.column} (${p.method === 'zscore' ? '|z| > ' + (p.threshold || 3) : 'IQR × ' + (p.threshold || 1.5)})`,
      pandas: (p) => {
        const c = py(p.column), k = p.threshold || (p.method === 'zscore' ? 3 : 1.5);
        const b = p.method === 'zscore' ? `_m, _s = df[${c}].mean(), df[${c}].std()\n_lo, _hi = _m - ${k} * _s, _m + ${k} * _s` : `_q1, _q3 = df[${c}].quantile([0.25, 0.75])\n_lo, _hi = _q1 - ${k} * (_q3 - _q1), _q3 + ${k} * (_q3 - _q1)`;
        const a = { remove: `df = df[df[${c}].isna() | df[${c}].between(_lo, _hi)]`, cap: `df[${c}] = df[${c}].clip(_lo, _hi)`, flag: `df[${py(p.column + '_outlier')}] = ~df[${c}].between(_lo, _hi) & df[${c}].notna()` }[p.action || 'remove'];
        return b + '\n' + a;
      }
    },
    rename: {
      label: 'Rename column', group: 'Transform', affectedOnce: true, params: [{ k: 'column', t: 'column', label: 'Column' }, { k: 'to', t: 'text', label: 'New name' }],
      apply(t, p) { const o = clone(t); const ci = colIndex(o, p.column); if (!p.to) throw new Error('New name is required.'); o.columns[ci] = p.to; return { table: o, affected: 1 }; },
      describe: (p) => `Rename ${p.column} → ${p.to}`, pandas: (p) => `df = df.rename(columns={${py(p.column)}: ${py(p.to)}})`
    },
    snake_case_headers: {
      label: 'Normalize column names', group: 'Transform', affectedOnce: true, params: [],
      apply(t) { const o = clone(t); let n = 0; o.columns = o.columns.map(c => { const v = c.trim().replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || 'col'; if (v !== c) n++; return v; }); return { table: o, affected: n }; },
      describe: () => 'Normalize column names to snake_case',
      pandas: () => `df.columns = df.columns.str.strip().str.replace(r"([a-z])([A-Z])", r"\\1_\\2", regex=True).str.lower().str.replace(r"[^a-z0-9]+", "_", regex=True).str.strip("_")`
    },
    drop_columns: {
      label: 'Drop columns', group: 'Transform', affectedOnce: true, params: [{ k: 'columns', t: 'columns', label: 'Columns' }],
      apply(t, p) {
        const o = clone(t); const cs = new Set(targetCols(o, p.columns)); o.columns = o.columns.filter((_, i) => !cs.has(i));
        if (inPlace) { const desc = [...cs].sort((a, b) => b - a); for (const r of o.rows) for (const i of desc) r.splice(i, 1); } // keeps row identity (used by the Compare tab's step tracing)
        else o.rows = o.rows.map(r => r.filter((_, i) => !cs.has(i)));
        return { table: o, affected: cs.size };
      },
      describe: (p) => `Drop ${colList(p.columns)}`, pandas: (p) => `df = df.drop(columns=${py([].concat(p.columns))})`
    },
    filter: {
      label: 'Filter rows', group: 'Transform', params: [{ k: 'column', t: 'column', label: 'Column' }, { k: 'op', t: 'select', options: ['==', '!=', '>', '>=', '<', '<=', 'contains', 'not contains', 'is null', 'not null'], label: 'Condition' }, { k: 'value', t: 'text', label: 'Value' }],
      apply(t, p) {
        const o = clone(t); const ci = colIndex(o, p.column); const b = o.rows.length; const vn = looseNumber(p.value);
        const test = (v) => {
          const x = looseNumber(v), num = x !== null && vn !== null;
          switch (p.op) {
            case '==': return num ? x === vn : String(v) === String(p.value);
            case '!=': return num ? x !== vn : String(v) !== String(p.value);
            case '>': return num ? x > vn : String(v) > String(p.value);
            case '>=': return num ? x >= vn : String(v) >= String(p.value);
            case '<': return num ? x < vn : String(v) < String(p.value);
            case '<=': return num ? x <= vn : String(v) <= String(p.value);
            case 'contains': return String(v).toLowerCase().includes(String(p.value).toLowerCase());
            case 'not contains': return !String(v).toLowerCase().includes(String(p.value).toLowerCase());
            case 'is null': return isNull(v);
            case 'not null': return !isNull(v);
          }
          return true;
        };
        o.rows = o.rows.filter(r => { if (test(r[ci])) return true; note(r, `Filtered out (${p.column} ${p.op}${['is null', 'not null'].includes(p.op) ? '' : ' ' + p.value})`); return false; }); return { table: o, affected: b - o.rows.length };
      },
      describe: (p) => `Keep rows where ${p.column} ${p.op}${['is null', 'not null'].includes(p.op) ? '' : ' ' + p.value}`,
      pandas: (p) => { const c = `df[${py(p.column)}]`, v = looseNumber(p.value) !== null ? p.value : py(p.value); return `df = df[${({ 'contains': `${c}.astype("string").str.contains(${py(p.value)}, case=False, na=False)`, 'not contains': `~${c}.astype("string").str.contains(${py(p.value)}, case=False, na=False)`, 'is null': `${c}.isna()`, 'not null': `${c}.notna()` })[p.op] || `${c} ${p.op} ${v}`}]`; }
    },
    replace: {
      label: 'Find and replace', group: 'Transform', params: [{ k: 'columns', t: 'columns', label: 'Columns' }, { k: 'find', t: 'text', label: 'Find' }, { k: 'with', t: 'text', label: 'Replace with' }, { k: 'regex', t: 'bool', label: 'Regular expression' }],
      apply(t, p) { const o = clone(t); let n = 0; const re = p.regex ? new RegExp(p.find, 'g') : null; for (const ci of targetCols(o, p.columns)) for (const r of o.rows) { if (isNull(r[ci])) continue; const s = String(r[ci]); const v = re ? s.replace(re, p.with || '') : s.split(p.find).join(p.with || ''); if (v !== s) { r[ci] = v; n++; } } return { table: o, affected: n }; },
      describe: (p) => `Replace "${p.find}" with "${p.with || ''}" in ${colList(p.columns)}`,
      pandas: (p) => [].concat(p.columns).map(c => `df[${py(c)}] = df[${py(c)}].astype("string").str.replace(${py(p.find)}, ${py(p.with || '')}, regex=${p.regex ? 'True' : 'False'})`).join('\n')
    },
    split: {
      label: 'Split column', group: 'Transform', params: [{ k: 'column', t: 'column', label: 'Column' }, { k: 'delimiter', t: 'text', label: 'Delimiter' }, { k: 'parts', t: 'number', label: 'Max parts' }],
      apply(t, p) {
        const o = clone(t); const ci = colIndex(o, p.column); const d = p.delimiter || ' '; const k = Math.max(2, +p.parts || 2);
        const names = Array.from({ length: k }, (_, i) => `${p.column}_${i + 1}`); o.columns.splice(ci + 1, 0, ...names); let n = 0;
        for (const r of o.rows) { const s = isNull(r[ci]) ? [] : String(r[ci]).split(d); const parts = s.length > k ? [...s.slice(0, k - 1), s.slice(k - 1).join(d)] : s; while (parts.length < k) parts.push(''); r.splice(ci + 1, 0, ...parts.map(x => x.trim())); if (s.length > 1) n++; }
        return { table: o, affected: n };
      },
      describe: (p) => `Split ${p.column} on "${p.delimiter || ' '}" into ${p.parts || 2} columns`,
      pandas: (p) => `_parts = df[${py(p.column)}].astype("string").str.split(${py(p.delimiter || ' ')}, n=${(+p.parts || 2) - 1}, expand=True)\nfor _i in range(_parts.shape[1]):\n    df[f"${p.column}_{_i + 1}"] = _parts[_i].str.strip()`
    },
    derive: {
      label: 'Derive column (formula)', group: 'Transform', params: [{ k: 'name', t: 'text', label: 'New column name' }, { k: 'expr', t: 'text', label: 'Formula, e.g. [price] * [qty]' }],
      apply(t, p) {
        const o = clone(t); if (!p.name || !p.expr) throw new Error('Name and formula are required.');
        if (/[;{}`]|=>|\b(function|window|document|fetch|import|eval|new|this|constructor|prototype|globalThis|self)\b/.test(p.expr.replace(/\[[^\]]+\]/g, ''))) throw new Error('Formula may only use column references, numbers, + - * / % ( ) and Math functions.');
        const refs = []; const body = p.expr.replace(/\[([^\]]+)\]/g, (_, c) => { refs.push(colIndex(o, c.trim())); return `__v[${refs.length - 1}]`; });
        const fn = new Function('__v', 'Math', `"use strict"; return (${body});`);
        o.columns.push(p.name); let n = 0;
        for (const r of o.rows) { const vals = refs.map(ci => { const x = looseNumber(r[ci]); return x === null ? (isNull(r[ci]) ? null : r[ci]) : x; }); let v; try { v = vals.some(x => x === null) ? '' : fn(vals, Math); } catch { v = ''; } if (typeof v === 'number') { if (!Number.isFinite(v)) v = ''; else v = Math.round(v * 1e8) / 1e8; } r.push(v); if (v !== '') n++; }
        return { table: o, affected: n };
      },
      describe: (p) => `Add ${p.name} = ${p.expr}`,
      pandas: (p) => `df[${py(p.name)}] = ${p.expr.replace(/\[([^\]]+)\]/g, (_, c) => `df[${py(c.trim())}]`).replace(/Math\.(\w+)/g, 'np.$1')}`
    },
    scale: {
      label: 'Scale / normalize', group: 'Transform', params: [{ k: 'columns', t: 'columns', label: 'Columns' }, { k: 'method', t: 'select', options: ['zscore', 'minmax', 'log1p'], label: 'Method' }],
      apply(t, p) { return fitAndApply(this, t, p); },
      fitInit(t, p) { const cols = targetCols(t, p.columns); return { cols, bufs: cols.map(() => new NumBuf()) }; },
      fitAdd(st, t) { st.cols.forEach((ci, k) => { const b = st.bufs[k]; for (const r of t.rows) { const x = looseNumber(r[ci]); if (x !== null) b.push(x); } }); },
      fitDone(st) { return { stats: st.bufs.map(b => numStatsSorted(b.sorted())) }; },
      applyFit(t, p, f) {
        const o = clone(t); let n = 0;
        for (const [k, ci] of targetCols(o, p.columns).entries()) {
          const st = f.stats[k]; if (!st) continue;
          for (const r of o.rows) { const x = looseNumber(r[ci]); if (x === null) continue; let v = p.method === 'minmax' ? (st.max === st.min ? 0 : (x - st.min) / (st.max - st.min)) : p.method === 'log1p' ? (x > -1 ? Math.log1p(x) : '') : (st.std ? (x - st.mean) / st.std : 0); if (v !== '') v = Math.round(v * 1e6) / 1e6; r[ci] = v; n++; }
        }
        return { table: o, affected: n };
      },
      describe: (p) => `Scale ${colList(p.columns)} (${p.method || 'zscore'})`,
      pandas: (p) => [].concat(p.columns).map(c => { const s = `df[${py(c)}]`; return `${s} = ${({ minmax: `(${s} - ${s}.min()) / (${s}.max() - ${s}.min())`, log1p: `np.log1p(${s})`, zscore: `(${s} - ${s}.mean()) / ${s}.std()` })[p.method || 'zscore']}`; }).join('\n')
    },
    one_hot: {
      label: 'One-hot encode', group: 'Transform', params: [{ k: 'column', t: 'column', label: 'Column' }, { k: 'maxCategories', t: 'number', label: 'Max categories' }],
      affectedOnce: true,
      apply(t, p) { return fitAndApply(this, t, p); },
      fitInit(t, p) { return { ci: colIndex(t, p.column), counts: new Map(), k: +p.maxCategories || 12 }; },
      fitAdd(st, t) { for (const r of t.rows) { const v = r[st.ci]; if (isNull(v)) continue; const key = String(v), n = st.counts.get(key); st.counts.set(n === undefined ? own(key) : key, (n || 0) + 1); } if (st.counts.size > FIT_MAX_DISTINCT) throw new Error(tooManyDistinct(t.columns[st.ci])); },
      fitDone(st) { return { cats: topOf(st.counts, st.k).map(x => x.value) }; },
      applyFit(t, p, f) {
        const o = clone(t); const ci = colIndex(o, p.column); const cats = f.cats;
        o.columns.push(...cats.map(c => `${p.column}_${c}`.replace(/\s+/g, '_'))); for (const r of o.rows) r.push(...cats.map(c => String(r[ci]) === c ? 1 : 0));
        return { table: o, affected: cats.length };
      },
      describe: (p) => `One-hot encode ${p.column} (top ${p.maxCategories || 12})`,
      pandas: (p) => `df = pd.concat([df, pd.get_dummies(df[${py(p.column)}], prefix=${py(p.column)}, dtype=int)], axis=1)`
    },
    round: {
      label: 'Round numbers', group: 'Transform', params: [{ k: 'columns', t: 'columns', label: 'Columns' }, { k: 'decimals', t: 'number', label: 'Decimals' }],
      apply(t, p) { const o = clone(t); let n = 0; const d = +p.decimals || 0, f = 10 ** d; for (const ci of targetCols(o, p.columns)) for (const r of o.rows) { const x = looseNumber(r[ci]); if (x === null) continue; const v = Math.round(x * f) / f; if (v !== r[ci]) { r[ci] = v; n++; } } return { table: o, affected: n }; },
      describe: (p) => `Round ${colList(p.columns)} to ${p.decimals || 0} decimals`,
      pandas: (p) => [].concat(p.columns).map(c => `df[${py(c)}] = df[${py(c)}].round(${p.decimals || 0})`).join('\n')
    },
    mask: {
      label: 'Protect personal data', group: 'Privacy',
      params: [{ k: 'columns', t: 'columns', label: 'Columns' }, { k: 'method', t: 'select', options: Object.keys(MASK_METHODS), labels: MASK_METHODS, label: 'Method' },
        { k: 'keep', t: 'number', label: 'Characters to keep (partial: last; generalize prefix: first)' }, { k: 'as', t: 'select', options: ['auto', 'band', 'year', 'prefix'], labels: { auto: 'Automatic', band: 'Number bands (e.g. 30-39)', year: 'Dates to year', prefix: 'Code prefix (e.g. ZIP 941**)' }, label: 'Generalize to' }, { k: 'bucket', t: 'number', label: 'Band width (generalize)' }, { k: 'key', t: 'text', label: 'Secret key (pseudonymize)' }],
      apply(t, p) {
        const o = clone(t); let n = 0; const m = p.method || 'hash';
        const f = { hash: (v) => pseudonym(v, p.key), partial: (v) => partialMask(v, p.keep ?? 4), redact: () => '[REDACTED]', generalize: (v) => generalize(v, p.bucket, p.as || 'auto', p.keep ?? 3), text: (v) => redactTextPII(String(v)), null: () => '' }[m];
        if (!f) throw new Error('Unknown masking method ' + m);
        for (const ci of targetCols(o, p.columns)) for (const r of o.rows) { if (isNull(r[ci])) continue; const v = f(r[ci]); if (v !== r[ci]) { r[ci] = v; n++; } }
        return { table: o, affected: n };
      },
      describe: (p) => `${{ hash: 'Pseudonymize', partial: 'Partially hide', redact: 'Redact', generalize: 'Generalize', text: 'Redact personal data inside', null: 'Remove' }[p.method || 'hash'] || 'Mask'} ${colList(p.columns)}`,
      pandas: (p) => {
        const cols = [].concat(p.columns || []), m = p.method || 'hash', body = (fn) => cols.map(c => `df[${py(c)}] = df[${py(c)}].map(lambda v: v if pd.isna(v) else ${fn})`).join('\n');
        if (m === 'hash') return `import hashlib\n_key = ${py(p.key || '')}\n_norm = lambda s: s.strip().lower() if "@" in s else s.strip()\n` + body(`"tok_" + hashlib.sha256((_key + "|" + _norm(str(v))).encode()).hexdigest()[:16]`);
        if (m === 'redact') return body('"[REDACTED]"');
        if (m === 'null') return cols.map(c => `df[${py(c)}] = pd.NA`).join('\n');
        if (m === 'partial') return `import re\ndef _partial(s, k=${p.keep ?? 4}):\n    s = str(s)\n    if re.fullmatch(r"[^\\s@]+@[^\\s@]+\\.[A-Za-z]{2,}", s.strip()):\n        local, dom = s.strip().split("@", 1)\n        return local[0] + "***@" + dom\n    out, seen = list(s), 0\n    for i in range(len(out) - 1, -1, -1):\n        if out[i].isalnum() and out[i].isascii():\n            if seen >= k: out[i] = "*"\n            seen += 1\n    return "".join(out)\n` + body('_partial(v)');
        if (m === 'text') return `import re\n_PII = [(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}", "[EMAIL]"), (r"\\b\\d{3}-\\d{2}-\\d{4}\\b", "[SSN]"), (r"(?:\\+\\d{1,3}[ .-]?)?\\(?\\d{2,4}\\)?[ .-]\\d{3,4}[ .-]?\\d{3,4}\\b", "[PHONE]")]\ndef _redact(s):\n    for pat, rep in _PII: s = re.sub(pat, rep, str(s))\n    return s  # cards, IBANs and IPs are also redacted in QuantETL (with check-digit validation)\n` + body('_redact(v)');
        const w = +p.bucket || 10, k = p.keep ?? 3, as = p.as || 'auto';
        if (as === 'band') return body(`f"{int(float(v) // ${w} * ${w})}-{int(float(v) // ${w} * ${w} + ${w - 1})}"`);
        if (as === 'year') return body(`str(pd.to_datetime(v, errors="coerce").year)`);
        if (as === 'prefix') return body(`str(v).strip()[:${k}].upper() + "*" * max(0, len(str(v).strip().replace(" ", "")) - ${k})`);
        return `# Generalize (automatic): dates to year, small numbers to bands of ${w}, codes to their first ${k} characters\n` + body(`str(v)  # see QuantETL's generalize rules; choose band, year or prefix for exact Python output`);
      }
    },
    text_quality: {
      label: 'Filter low-quality text', group: 'AI data',
      params: [{ k: 'column', t: 'column', label: 'Text column' }, { k: 'preset', t: 'select', options: ['documents', 'short'], labels: { documents: 'Documents and web pages (Gopher/C4-style rules)', short: 'Short text: chat turns, answers, reviews' }, label: 'Kind of text' },
        { k: 'action', t: 'select', options: ['remove', 'flag'], labels: { remove: 'Remove failing rows', flag: 'Keep them and add a reason column' }, label: 'Action' },
        { k: 'minWords', t: 'number', label: 'Minimum words (empty = preset)' }, { k: 'maxWords', t: 'number', label: 'Maximum words (empty = preset)' },
        { k: 'minAlphaWords', t: 'number', label: 'Minimum share of words with letters, 0–1 (empty = preset)' }, { k: 'maxDupLines', t: 'number', label: 'Maximum share of repeated lines, 0–1 (empty = preset)' }],
      apply(t, p) {
        const o = clone(t), ci = colIndex(o, p.column), th = qualityThresholds(p), action = p.action || 'remove'; let n = 0;
        if (action === 'flag') { o.columns.push(uniqueName(t, p.column + '_quality_issue')); for (const r of o.rows) { const why = qualityIssue(textOf(r[ci]), th); r.push(why ? QUALITY_REASONS[why] : ''); if (why) n++; } }
        else { const b = o.rows.length; o.rows = o.rows.filter(r => { const why = qualityIssue(textOf(r[ci]), th); if (why) note(r, QUALITY_REASONS[why]); return !why; }); n = b - o.rows.length; }
        return { table: o, affected: n };
      },
      describe: (p) => `${(p.action || 'remove') === 'flag' ? 'Flag' : 'Remove'} rows whose ${p.column} fails the ${p.preset === 'short' ? 'short-text' : 'document'} quality rules`,
      pandas: (p) => `# Quality filter on ${p.column}: QuantETL's Gopher/C4-style rules (word count, letter share, word length, symbols,\n# repeated lines and phrases, boilerplate). Thresholds: ${JSON.stringify(qualityThresholds(p))}\n_w = df[${py(p.column)}].astype("string").str.split().str.len()\ndf = df[_w.between(${qualityThresholds(p).minWords}, ${qualityThresholds(p).maxWords})]  # word-count part only`
    },
    language: {
      label: 'Detect language', group: 'AI data',
      params: [{ k: 'column', t: 'column', label: 'Text column' }, { k: 'keep', t: 'text', label: 'Keep only these languages (codes, e.g. en, de; empty = keep all)' }, { k: 'minScore', t: 'number', label: 'Minimum confidence 0–1 when keeping (empty = 0)' }],
      apply(t, p) {
        const o = clone(t), ci = colIndex(o, p.column), keep = String(p.keep || '').toLowerCase().split(/[\s,;]+/).filter(Boolean), min = +p.minScore || 0;
        o.columns.push(uniqueName(t, 'lang'), uniqueName({ columns: [...t.columns, 'lang'] }, 'lang_score'));
        let n = 0; const out = [];
        for (const r of o.rows) {
          const d = detectLanguage(textOf(r[ci]));
          r.push(d.lang, d.score);
          if (keep.length && (!keep.includes(d.lang) || d.score < min)) { note(r, `Language ${LANGUAGES[d.lang] || d.lang}${keep.includes(d.lang) ? ' (low confidence)' : ''}`); n++; continue; }
          out.push(r); if (!keep.length && d.lang !== 'und') n++;
        }
        if (keep.length) o.rows = out;
        return { table: o, affected: n };
      },
      describe: (p) => p.keep ? `Detect the language of ${p.column} and keep only ${String(p.keep).toLowerCase().split(/[\s,;]+/).filter(Boolean).join(', ')}` : `Detect the language of ${p.column} (adds lang)`,
      pandas: (p) => `# Language detection: QuantETL's offline detector (scripts plus common words, 49 languages). A Python\n# equivalent is fastText's lid.176 model:\n#   import fasttext; _m = fasttext.load_model("lid.176.ftz")\n#   df["lang"] = df[${py(p.column)}].map(lambda s: _m.predict(str(s).replace("\\n", " "))[0][0].replace("__label__", ""))${p.keep ? `\n#   df = df[df["lang"].isin(${py(String(p.keep).toLowerCase().split(/[\s,;]+/).filter(Boolean))})]` : ''}`
    },
    near_duplicates: {
      label: 'Remove near-duplicate text', group: 'AI data',
      params: [{ k: 'column', t: 'column', label: 'Text column' }, { k: 'threshold', t: 'number', label: 'Similarity threshold 0–1 (default 0.8; lower removes more)' },
        { k: 'action', t: 'select', options: ['remove', 'flag'], labels: { remove: 'Remove duplicates (keep the first)', flag: 'Keep them and add duplicate_of (row number)' }, label: 'Action' }],
      apply(t, p) { return this.applyChunk(t, p, {}); },
      applyChunk(t, p, st) { // the index carries over between chunks, so a duplicate is found anywhere in the file
        const o = clone(t), ci = colIndex(o, p.column), th = p.threshold === undefined || p.threshold === '' ? 0.8 : +p.threshold;
        if (!(th > 0 && th <= 1)) throw new Error('The similarity threshold must be between 0 and 1.');
        st.index = st.index || new NearDupIndex({ threshold: th }); st.row = st.row || 0;
        let n = 0;
        if ((p.action || 'remove') === 'flag') {
          o.columns.push(uniqueName(t, p.column + '_duplicate_of'));
          for (const r of o.rows) { const d = st.index.check(textOf(r[ci]), ++st.row); r.push(d ? d.row : ''); if (d) n++; }
        } else {
          const b = o.rows.length;
          o.rows = o.rows.filter(r => { const d = st.index.check(textOf(r[ci]), ++st.row); if (d) note(r, d.exact ? 'Exact duplicate' : 'Near duplicate', d.exact ? `of row ${d.row}` : `of row ${d.row}, ${Math.round(d.sim * 100)}% similar`); return !d; });
          n = b - o.rows.length;
        }
        return { table: o, affected: n };
      },
      describe: (p) => `${(p.action || 'remove') === 'flag' ? 'Flag' : 'Remove'} rows whose ${p.column} duplicates an earlier one, exactly or nearly (similarity ≥ ${p.threshold || 0.8})`,
      pandas: (p) => `# Near-duplicate removal: QuantETL uses MinHash (word 5-grams, 100 bins) with LSH (20 bands of 5), keeping the\n# first text. A Python equivalent with the datasketch package:\n#   from datasketch import MinHash, MinHashLSH\n#   lsh, keep = MinHashLSH(threshold=${p.threshold || 0.8}, num_perm=128), []\n#   for i, s in enumerate(df[${py(p.column)}].astype(str)):\n#       w = s.lower().split(); m = MinHash(num_perm=128)\n#       for g in zip(*[w[k:] for k in range(5)]): m.update(" ".join(g).encode())\n#       if not lsh.query(m): lsh.insert(str(i), m); keep.append(i)\n#   df = df.iloc[keep]\ndf = df.drop_duplicates(subset=[${py(p.column)}])  # exact duplicates only`
    },
    redact_text: {
      label: 'Redact personal data in text', group: 'AI data',
      params: [{ k: 'columns', t: 'columns', label: 'Text columns' }, { k: 'kinds', t: 'text', label: 'Kinds (empty = all): email, phone, card, ssn, iban, ipv4' }, { k: 'style', t: 'select', options: ['brackets', 'tokens'], labels: { brackets: '[EMAIL], [PHONE] …', tokens: '<|email|>, <|phone|> … (training tokens)' }, label: 'Placeholder style' }],
      apply(t, p) {
        const o = clone(t); let n = 0; const kinds = String(p.kinds || '').toLowerCase().split(/[\s,;]+/).filter(Boolean).map(k => (k === 'ip' ? 'ipv4' : k));
        const bad = kinds.filter(k => !REDACT_KINDS.includes(k)); if (bad.length) throw new Error(`Unknown kind ${bad.join(', ')}. Use ${REDACT_KINDS.join(', ')}.`);
        for (const ci of targetCols(o, p.columns)) for (const r of o.rows) { if (isNull(r[ci])) continue; const s = String(r[ci]), v = redactText(s, kinds.length ? kinds : null, p.style); if (v !== s) { r[ci] = v; n++; } }
        return { table: o, affected: n };
      },
      describe: (p) => `Redact ${p.kinds ? String(p.kinds) : 'emails, phones, cards, SSNs, IBANs and IPs'} inside ${colList(p.columns)}`,
      pandas: (p) => `import re\n_PII = [(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}", "EMAIL"), (r"\\b\\d{3}-\\d{2}-\\d{4}\\b", "SSN"), (r"(?:\\+\\d{1,3}[ .-]?)?\\(?\\d{2,4}\\)?[ .-]\\d{3,4}[ .-]?\\d{3,4}\\b", "PHONE"), (r"\\b(?:(?:25[0-5]|2[0-4]\\d|1?\\d?\\d)\\.){3}(?:25[0-5]|2[0-4]\\d|1?\\d?\\d)\\b", "IP")]\ndef _redact(s):\n    for pat, kind in _PII: s = re.sub(pat, ${p.style === 'tokens' ? '"<|" + kind.lower() + "|>"' : '"[" + kind + "]"'}, str(s))\n    return s  # QuantETL also redacts card numbers and IBANs (with check-digit validation)\n` + targetColsPy(p.columns).map(c => `df[${py(c)}] = df[${py(c)}].map(lambda v: v if pd.isna(v) else _redact(v))`).join('\n')
    },
    token_count: {
      label: 'Count tokens (estimate)', group: 'AI data', params: [{ k: 'column', t: 'column', label: 'Text column' }],
      apply(t, p) { const o = clone(t), ci = colIndex(o, p.column); o.columns.push(uniqueName(t, p.column + '_tokens')); for (const r of o.rows) r.push(estimateTokens(textOf(r[ci]))); return { table: o, affected: o.rows.length }; },
      describe: (p) => `Add ${p.column}_tokens (estimated token count)`,
      pandas: (p) => `_s = df[${py(p.column)}].fillna("").astype(str)\ndf[${py(p.column + '_tokens')}] = ((_s.str.len() / 4).combine(_s.str.split().str.len() * 1.33, max)).round().astype(int)  # estimate; use tiktoken for exact counts`
    },
    length_filter: {
      label: 'Filter by text length', group: 'AI data',
      params: [{ k: 'column', t: 'column', label: 'Text column' }, { k: 'unit', t: 'select', options: ['words', 'chars', 'tokens'], labels: { words: 'Words', chars: 'Characters', tokens: 'Tokens (estimated)' }, label: 'Measure' }, { k: 'min', t: 'number', label: 'Minimum (empty = none)' }, { k: 'max', t: 'number', label: 'Maximum (empty = none)' }],
      apply(t, p) {
        const has = (v) => v !== undefined && v !== null && v !== ''; if (!has(p.min) && !has(p.max)) throw new Error('Set a minimum, a maximum, or both.');
        const o = clone(t), ci = colIndex(o, p.column), unit = p.unit || 'words', b = o.rows.length;
        o.rows = o.rows.filter(r => { const L = textLength(textOf(r[ci]), unit); if (has(p.min) && L < +p.min) { note(r, `Shorter than ${p.min} ${unit}`); return false; } if (has(p.max) && L > +p.max) { note(r, `Longer than ${p.max} ${unit}`); return false; } return true; });
        return { table: o, affected: b - o.rows.length };
      },
      describe: (p) => `Keep ${p.column} between ${p.min ?? 0} and ${p.max ?? '∞'} ${p.unit || 'words'}`,
      pandas: (p) => { const m = { words: `df[${py(p.column)}].fillna("").astype(str).str.split().str.len()`, chars: `df[${py(p.column)}].fillna("").astype(str).str.len()`, tokens: `(df[${py(p.column)}].fillna("").astype(str).str.len() / 4)` }[p.unit || 'words']; return `_n = ${m}\ndf = df[${[p.min !== undefined && p.min !== '' ? `(_n >= ${p.min})` : null, p.max !== undefined && p.max !== '' ? `(_n <= ${p.max})` : null].filter(Boolean).join(' & ') || 'True'}]`; }
    },
    train_test_split: {
      label: 'Train / validation / test split', group: 'AI data',
      params: [{ k: 'key', t: 'column', label: 'Assign by (empty = whole row)', optional: true }, { k: 'group', t: 'column', label: 'Keep groups together (optional, e.g. user or document id)', optional: true }, { k: 'train', t: 'number', label: 'Train %' }, { k: 'validation', t: 'number', label: 'Validation %' }, { k: 'test', t: 'number', label: 'Test %' }, { k: 'seed', t: 'text', label: 'Seed (change it to reshuffle)' }],
      apply(t, p) {
        const tr = p.train === undefined || p.train === '' ? 80 : +p.train, va = p.validation === undefined || p.validation === '' ? 10 : +p.validation, te = p.test === undefined || p.test === '' ? 10 : +p.test;
        if ([tr, va, te].some(x => !(x >= 0)) || Math.abs(tr + va + te - 100) > 1e-6) throw new Error('Train, validation and test must add up to 100.');
        const o = clone(t), gi = p.group ? colIndex(o, p.group) : -1, ki = p.key ? colIndex(o, p.key) : -1;
        o.columns.push(uniqueName(t, 'split'));
        for (const r of o.rows) { const key = gi >= 0 ? textOf(r[gi]) : ki >= 0 ? textOf(r[ki]) : r.map(textOf).join('\u0001'); const x = splitBucket(key, p.seed) * 100; r.push(x < tr ? 'train' : x < tr + va ? 'validation' : 'test'); }
        return { table: o, affected: o.rows.length };
      },
      describe: (p) => `Split rows ${p.train ?? 80}/${p.validation ?? 10}/${p.test ?? 10} into train, validation and test${p.group ? ` keeping each ${p.group} together` : ''}`,
      pandas: (p) => `import hashlib\n_key = ${p.group ? `df[${py(p.group)}].astype(str)` : p.key ? `df[${py(p.key)}].astype(str)` : 'df.astype(str).agg("\\x01".join, axis=1)'}\n_x = _key.map(lambda k: int(hashlib.sha256((${py(p.seed || '')} + "\\x00" + k).encode()).hexdigest()[:8], 16) / 2**32 * 100)  # QuantETL uses its own 32-bit hash; splits are stable but differ from this\ndf["split"] = pd.cut(_x, [-1, ${p.train ?? 80}, ${(+(p.train ?? 80)) + (+(p.validation ?? 10))}, 101], labels=["train", "validation", "test"]).astype(str)`
    },
    format_chat: {
      label: 'Build fine-tuning records', group: 'AI data',
      params: [{ k: 'template', t: 'select', options: ['messages', 'prompt_completion', 'instruction'], labels: { messages: 'Chat messages (system, user, assistant)', prompt_completion: 'Prompt and completion', instruction: 'Instruction, input and output' }, label: 'Format' },
        { k: 'prompt', t: 'column', label: 'Prompt / user / instruction column' }, { k: 'response', t: 'column', label: 'Response / assistant / output column' }, { k: 'context', t: 'column', label: 'Extra input column (optional)', optional: true }, { k: 'system', t: 'text', label: 'System message (chat format, optional)' }],
      apply(t, p) {
        const o = clone(t), pi = colIndex(o, p.prompt), ri = colIndex(o, p.response), xi = p.context ? colIndex(o, p.context) : -1, tpl = p.template || 'messages'; let n = 0;
        o.columns.push(uniqueName(t, 'training_record'));
        for (const r of o.rows) {
          const q = textOf(r[pi]).trim(), a = textOf(r[ri]).trim(), x = xi >= 0 ? textOf(r[xi]).trim() : '';
          if (!q || !a) { r.push(''); continue; }
          const rec = tpl === 'prompt_completion' ? { prompt: x ? `${q}\n\n${x}` : q, completion: a } : tpl === 'instruction' ? { instruction: q, input: x, output: a }
            : { messages: [...(p.system ? [{ role: 'system', content: String(p.system) }] : []), { role: 'user', content: x ? `${q}\n\n${x}` : q }, { role: 'assistant', content: a }] };
          r.push(JSON.stringify(rec)); n++;
        }
        return { table: o, affected: n };
      },
      describe: (p) => `Build ${({ messages: 'chat', prompt_completion: 'prompt/completion', instruction: 'instruction' })[p.template || 'messages']} fine-tuning records from ${p.prompt} and ${p.response}`,
      pandas: (p) => { const q = `str(r[${py(p.prompt)}]).strip()`, a = `str(r[${py(p.response)}]).strip()`, x = p.context ? `(str(r[${py(p.context)}]).strip() if pd.notna(r[${py(p.context)}]) else "")` : '""';
        const rec = (p.template || 'messages') === 'prompt_completion' ? `{"prompt": (q + "\\n\\n" + x) if x else q, "completion": a}` : p.template === 'instruction' ? `{"instruction": q, "input": x, "output": a}` : `{"messages": ${p.system ? `[{"role": "system", "content": ${py(p.system)}}] + ` : ''}[{"role": "user", "content": (q + "\\n\\n" + x) if x else q}, {"role": "assistant", "content": a}]}`;
        return `import json\ndef _record(r):\n    q, a, x = ${q}, ${a}, ${x}\n    return json.dumps(${rec}, ensure_ascii=False) if q and a else None\ndf["training_record"] = df.apply(_record, axis=1)`; }
    },
    sort: {
      label: 'Sort rows', group: 'Transform', params: [{ k: 'column', t: 'column', label: 'Column' }, { k: 'order', t: 'select', options: ['asc', 'desc'], label: 'Order' }],
      apply(t, p) { const o = clone(t); const ci = colIndex(o, p.column); const dir = p.order === 'desc' ? -1 : 1; o.rows.sort((a, b) => { const x = looseNumber(a[ci]), y = looseNumber(b[ci]); if (isNull(a[ci])) return 1; if (isNull(b[ci])) return -1; return (x !== null && y !== null ? x - y : String(a[ci]).localeCompare(String(b[ci]))) * dir; }); return { table: o, affected: o.rows.length }; },
      describe: (p) => `Sort by ${p.column} ${p.order === 'desc' ? 'descending' : 'ascending'}`,
      pandas: (p) => `df = df.sort_values(${py(p.column)}, ascending=${p.order === 'desc' ? 'False' : 'True'})`
    }
  };

  // How a step runs over a large file in chunks on the server. 'row': apply() per chunk. 'state': applyChunk() with
  // state carried between chunks. 'fit': one pass to fit, then applyFit() per chunk. null: not available yet.
  function streamMode(s) {
    const p = s.params || {};
    if (!OPS[s.op] || s.op === 'sort') return null;
    if (s.op === 'drop_duplicates') return p.keep === 'last' ? null : 'state';
    if (s.op === 'near_duplicates') return 'state';
    if (s.op === 'fill_null') { const k = p.strategy || 'median'; return k === 'bfill' ? null : k === 'ffill' ? 'state' : k === 'constant' ? 'row' : 'fit'; }
    return OPS[s.op].fitInit ? 'fit' : 'row';
  }

  function runPipeline(base, steps, uptoIndex = steps.length) {
    let t = base; const results = [];
    for (let i = 0; i < Math.min(uptoIndex, steps.length); i++) {
      const s = steps[i];
      if (s.disabled) { results.push({ id: s.id, skipped: true }); continue; }
      const op = OPS[s.op];
      const t0 = performance.now();
      try {
        if (!op) throw new Error('Unknown operation ' + s.op);
        const before = t.rows.length; const r = op.apply(t, s.params || {}); t = r.table;
        results.push({ id: s.id, affected: r.affected, rowsBefore: before, rowsAfter: t.rows.length, ms: performance.now() - t0 });
      } catch (e) { results.push({ id: s.id, error: e.message }); }
    }
    return { table: t, results };
  }

  function toPandas(steps, sourceName) {
    const body = steps.filter(s => !s.disabled && OPS[s.op]).map((s, i) => `# ${i + 1}. ${OPS[s.op].describe(s.params || {})}\n${OPS[s.op].pandas(s.params || {})}`).join('\n\n');
    return `# Generated by QuantETL · QETL R1\nimport numpy as np\nimport pandas as pd\n\ndf = pd.read_csv(${py(sourceName || 'data.csv')})\n\n${body || '# (no steps yet)'}\n\ndf.to_csv(${py((sourceName || 'data.csv').replace(/\.\w+$/, '') + '_clean.csv')}, index=False)\n`;
  }

  /* ---------- Analysis ---------- */
  function numericColumns(t, prof) { return (prof || profile(t)).columns.filter(c => ['number', 'integer'].includes(c.type)).map(c => c.name); }
  function correlation(t, cols) {
    const idx = cols.map(c => colIndex(t, c)); const n = cols.length; const m = Array.from({ length: n }, () => Array(n).fill(null));
    for (let a = 0; a < n; a++) for (let b = a; b < n; b++) {
      let sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0, k = 0;
      for (const r of t.rows) { const x = looseNumber(r[idx[a]]), y = looseNumber(r[idx[b]]); if (x === null || y === null) continue; sx += x; sy += y; sxx += x * x; syy += y * y; sxy += x * y; k++; }
      const den = Math.sqrt((k * sxx - sx * sx) * (k * syy - sy * sy)); const v = k > 2 && den ? (k * sxy - sx * sy) / den : null;
      m[a][b] = m[b][a] = v === null ? null : Math.max(-1, Math.min(1, v));
    }
    return { cols, matrix: m };
  }
  function groupBy(t, by, valueCol, agg = 'mean') {
    const bi = colIndex(t, by), vi = valueCol ? colIndex(t, valueCol) : -1; const g = new Map();
    for (const r of t.rows) { const k = isNull(r[bi]) ? '(null)' : String(r[bi]); if (!g.has(k)) g.set(k, []); if (vi >= 0) { const x = looseNumber(r[vi]); if (x !== null) g.get(k).push(x); } else g.get(k).push(1); }
    const f = { mean: a => a.length ? sum(a) / a.length : null, sum, count: a => a.length, min: a => a.length ? minOf(a) : null, max: a => a.length ? maxOf(a) : null, median: a => a.length ? quantile([...a].sort((x, y) => x - y), .5) : null }[agg] || (a => a.length);
    return [...g.entries()].map(([key, a]) => ({ key, value: f(a), n: a.length })).sort((a, b) => (b.value ?? -Infinity) - (a.value ?? -Infinity));
  }

  function toCSV(t) {
    const esc = (v) => { if (v === null || v === undefined) return ''; const s = String(v); return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
    return [t.columns.map(esc).join(','), ...t.rows.map(r => r.map(esc).join(','))].join('\n');
  }
  function toJSON(t) { return JSON.stringify(t.rows.map(r => Object.fromEntries(t.columns.map((c, i) => [c, isNull(r[i]) ? null : r[i]]))), null, 2); }

  /* ---------- Export typing (JSONL and Parquet) ---------- */
  // Narrowest type that holds every value of a column, so exports keep numbers as numbers without changing how any
  // value reads: "007" or "1.50" stay text. json: every value is JSON object/array text (written back as JSON).
  const EX_INT = /^-?(0|[1-9]\d*)$/, EX_NUM = /^-?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i, EX_DATE = /^\d{4}-\d{2}-\d{2}$/;
  const EX_TS = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,6}))?)?(Z|[+-]\d{2}:?\d{2})?$/;
  const exValidDate = (s) => { const d = new Date(s + 'T00:00:00Z'); return !isNaN(d) && d.toISOString().slice(0, 10) === s; };
  class TypeGuess {
    constructor() { this.int = this.num = this.bool = this.date = this.tsZ = this.tsN = this.json = true; this.any = false; }
    add(v) {
      if (v === null || v === undefined || v === '') return; this.any = true;
      if (typeof v === 'number') { this.bool = this.date = this.tsZ = this.tsN = this.json = false; if (!Number.isFinite(v)) this.int = this.num = false; else if (!Number.isSafeInteger(v)) this.int = false; return; }
      if (typeof v === 'boolean') { this.int = this.num = this.date = this.tsZ = this.tsN = this.json = false; return; }
      const s = String(v);
      if (this.bool && s !== 'true' && s !== 'false') this.bool = false;
      if (this.int && !(EX_INT.test(s) && Number.isSafeInteger(+s))) this.int = false;
      if (this.num && !(EX_NUM.test(s) && Number.isFinite(+s) && String(+s) === s)) this.num = false;
      if (this.date && !(EX_DATE.test(s) && exValidDate(s))) this.date = false;
      if (this.tsZ || this.tsN) { const m = EX_TS.exec(s); if (!m || !exValidDate(s.slice(0, 10))) this.tsZ = this.tsN = false; else if (m[8]) this.tsN = false; else this.tsZ = false; }
      if (this.json) { const c = s.charCodeAt(0); if (c !== 123 && c !== 91) this.json = false; else { try { const x = JSON.parse(s); if (x === null || typeof x !== 'object') this.json = false; } catch { this.json = false; } } }
    }
    type() { // Parquet type name
      if (!this.any) return 'string';
      if (this.bool) return 'boolean'; if (this.int) return 'int64'; if (this.num) return 'double';
      if (this.date) return 'date'; if (this.tsZ) return 'timestamp_utc'; if (this.tsN) return 'timestamp'; return 'string';
    }
    jsonKind() { if (!this.any) return 'string'; if (this.bool) return 'boolean'; if (this.int || this.num) return 'number'; if (this.json) return 'json'; return 'string'; }
  }
  function guessTypes(columns, rows) { const g = columns.map(() => new TypeGuess()); for (const r of rows) for (let c = 0; c < g.length; c++) g[c].add(r[c]); return g; }
  // Writes one record per line. Dot-path names are nested again (meta.source -> {"meta":{"source":…}}) unless that
  // would clash with another column; nulls are written as null. kinds: from guessTypes(...).map(g => g.jsonKind()).
  function jsonlWriter(columns, kinds) {
    const paths = columns.map(c => c.split('.'));
    const flat = new Set(columns); const clash = paths.map((p, i) => p.length > 1 && (p.some(s => !s) || p.slice(0, -1).some((_, k) => flat.has(p.slice(0, k + 1).join('.')))));
    const val = (v, k) => { if (v === null || v === undefined || v === '') return null; if (k === 'number') return typeof v === 'number' ? v : +v; if (k === 'boolean') return v === true || v === 'true'; if (k === 'json') return typeof v === 'string' ? JSON.parse(v) : v; return typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'boolean' ? v : String(v); };
    return (r) => {
      const o = {};
      for (let c = 0; c < columns.length; c++) {
        const v = val(r[c], kinds[c]);
        if (paths[c].length === 1 || clash[c]) { o[columns[c]] = v; continue; }
        let cur = o; const p = paths[c];
        for (let k = 0; k < p.length - 1; k++) { if (cur[p[k]] === undefined || cur[p[k]] === null || typeof cur[p[k]] !== 'object') cur[p[k]] = {}; cur = cur[p[k]]; }
        cur[p[p.length - 1]] = v;
      }
      return JSON.stringify(o);
    };
  }
  function toJSONL(t, opts = {}) {
    const g = guessTypes(t.columns, t.rows), kinds = g.map(x => x.jsonKind());
    if (opts.only) { const ci = colIndex(t, opts.only); return t.rows.filter(r => !isNull(r[ci])).map(r => (kinds[ci] === 'json' ? JSON.stringify(JSON.parse(r[ci])) : JSON.stringify(r[ci]))).join('\n') + '\n'; }
    const w = jsonlWriter(t.columns, kinds); return t.rows.map(w).join('\n') + (t.rows.length ? '\n' : '');
  }

  const QETL = { setReasonSink, estimateTokens, textLength, qualityIssue, qualityThresholds, QUALITY_PRESETS, QUALITY_REASONS, detectLanguage, LANGUAGES, NearDupIndex, normText, createContamination, contamination, redactText, REDACT_KINDS,
    setInPlace, flattenRecord, parseJSONLines, parseJSONL, TypeGuess, guessTypes, jsonlWriter, toJSONL, createProfiler, streamMode, numStatsSorted, RowHashSet, detectDelimiter, summarizeColumn, columnFromSummary, assembleProfile, suggestRange, inRange, isNull, parseFile, parseCSV, parseJSON, toNumber, looseNumber, parseDate, inferType, numStats, histogram, valueCounts, profile, profileColumn, OPS, runPipeline, toPandas, correlation, groupBy, numericColumns, toCSV, toJSON, colIndex, quantile,
    PII, findTextPII, redactTextPII, sha256, pseudonym, partialMask, generalize, MASK_METHODS, parseDateS };
  (typeof window !== 'undefined' ? window : globalThis).QETL = QETL; // browser, or a Node worker on the server
})();
