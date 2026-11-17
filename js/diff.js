/* QuantETL Diff: compares two versions of a table row by row and cell by cell.
   Runs on the user's machine; nothing here sends data anywhere.
   - matchColumns(A, B): same, renamed (by name similarity and shared values), added and removed columns.
   - findKeys(A, B, pairs): ranks the columns (or pairs of columns) that identify a row in both tables.
   - diffTables(A, B, opts): added, removed and changed rows, per-column changes, and how totals moved.
   - tracePipeline(base, steps, opts): the same result for a dataset's own pipeline, with every removed row and
     changed cell attributed to the step that did it. */
(function () {
  const G = typeof window !== 'undefined' ? window : globalThis;
  const Q = () => G.QETL;
  const isNull = (v) => Q().isNull(v);
  const txt = (v) => (v === null || v === undefined ? '' : String(v));
  const round = (x, d = 4) => Math.round(x * 10 ** d) / 10 ** d;

  /* ---------- Column matching ---------- */
  const normName = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '');
  function dice(x, y) {
    if (x.length < 2 || y.length < 2) return x === y ? 1 : 0;
    const A = new Map(); for (let i = 0; i < x.length - 1; i++) { const b = x.slice(i, i + 2); A.set(b, (A.get(b) || 0) + 1); }
    let n = 0; for (let i = 0; i < y.length - 1; i++) { const b = y.slice(i, i + 2), c = A.get(b); if (c) { n++; A.set(b, c - 1); } }
    return 2 * n / (x.length - 1 + y.length - 1);
  }
  function nameSim(a, b) {
    const x = normName(a), y = normName(b); if (!x || !y) return 0; if (x === y) return 1;
    return Math.max(dice(x, y), x.length >= 3 && y.length >= 3 && (x.includes(y) || y.includes(x)) ? 0.75 : 0);
  }
  const vkey = (v) => String(v).trim().toLowerCase();
  function sampleVals(t, ci, n = 2000) { const out = [], rows = t.rows, step = Math.max(1, rows.length / n); for (let i = 0; i < rows.length && out.length < n; i += step) { const v = rows[Math.floor(i)][ci]; if (!isNull(v)) out.push(vkey(v)); } return out; }
  function fullSet(t, ci) { const s = new Set(); for (const r of t.rows) { const v = r[ci]; if (!isNull(v)) s.add(vkey(v)); } return s; }

  function matchColumns(A, B) {
    const pairs = [], usedA = new Set(), usedB = new Set();
    const take = (i, j, how, extra) => { pairs.push({ a: i, b: j, nameA: A.columns[i], nameB: B.columns[j], how, ...extra }); usedA.add(i); usedB.add(j); };
    A.columns.forEach((c, i) => { const j = B.columns.findIndex((d, k) => !usedB.has(k) && d === c); if (j >= 0) take(i, j, 'same'); });
    A.columns.forEach((c, i) => { if (usedA.has(i)) return; const j = B.columns.findIndex((d, k) => !usedB.has(k) && normName(d) === normName(c)); if (j >= 0) take(i, j, 'renamed', { score: 1, nameSim: 1 }); });
    const ra = A.columns.map((_, i) => i).filter(i => !usedA.has(i)), rb = B.columns.map((_, j) => j).filter(j => !usedB.has(j));
    if (ra.length && rb.length && ra.length * rb.length <= 900) {
      const sa = new Map(ra.map(i => [i, sampleVals(A, i)])), fb = new Map(rb.map(j => [j, fullSet(B, j)])), cand = [];
      // Numbers rarely repeat between two different batches of records, so for numeric columns a similar median counts too.
      const med = (vals) => { const n = vals.map(v => Q().looseNumber(v)).filter(x => x !== null); if (n.length < Math.max(3, vals.length * 0.9)) return null; n.sort((x, y) => x - y); return n[Math.floor(n.length / 2)]; };
      const ma = new Map(ra.map(i => [i, med(sa.get(i))])), mb = new Map(rb.map(j => [j, med(sampleVals(B, j))]));
      for (const i of ra) for (const j of rb) {
        const vals = sa.get(i), set = fb.get(j), ns = nameSim(A.columns[i], B.columns[j]);
        let ov = vals.length ? vals.filter(v => set.has(v)).length / vals.length : 0;
        if (set.size < 20) ov *= 0.5; // a few shared small values (1-6, yes/no) prove little
        const x = ma.get(i), y = mb.get(j);
        if (ns >= 0.5 && x !== null && y !== null) ov = Math.max(ov, 1 - Math.min(1, Math.abs(x - y) / Math.max(Math.abs(x), Math.abs(y), 1e-9)));
        const s = 0.45 * ns + 0.55 * ov;
        if (s >= 0.5 && (ov >= 0.3 || ns >= 0.7)) cand.push({ i, j, s, ns, ov });
      }
      cand.sort((x, y) => y.s - x.s);
      for (const c of cand) if (!usedA.has(c.i) && !usedB.has(c.j)) take(c.i, c.j, 'renamed', { score: round(c.s, 3), nameSim: round(c.ns, 3), overlap: round(c.ov, 3) });
    }
    pairs.sort((x, y) => x.b - y.b);
    return { pairs, removed: A.columns.filter((_, i) => !usedA.has(i)), added: B.columns.filter((_, j) => !usedB.has(j)) };
  }

  /* ---------- Key detection ---------- */
  const ID_NAME = /(^|[^a-z])(id|key|uuid|guid|sku|code|ref|number|no|num)$|^id[^a-z]|^(id|key)$/i;
  const keyText = (v) => { let s = String(v).trim(); if (/^-?\d+\.0+$/.test(s)) s = s.replace(/\.0+$/, ''); return s; };
  function keyStats(t, idx) {
    const seen = new Set(); let nulls = 0, dup = 0;
    for (const r of t.rows) { if (idx.some(i => isNull(r[i]))) { nulls++; continue; } const k = idx.map(i => keyText(r[i])).join('\u0001'); if (seen.has(k)) dup++; else seen.add(k); }
    const n = t.rows.length || 1; return { set: seen, unique: seen.size / n, nulls: nulls / n, dup };
  }
  function kindOf(t, ci) {
    const vals = sampleVals(t, ci, 400); if (!vals.length) return 'empty';
    const dec = vals.filter(v => /^-?\d*\.\d+$/.test(v) && !/\.0+$/.test(v)).length / vals.length;
    if (dec > 0.5) return 'decimal';
    if (vals.filter(v => /^\d{4}-\d{2}-\d{2}|^\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}/.test(v)).length / vals.length > 0.8) return 'date';
    return 'id';
  }
  function findKeys(A, B, pairs) {
    const out = [];
    const score = (cols, sa, sb, bonus) => {
      let inter = 0; const [small, big] = sa.set.size < sb.set.size ? [sa.set, sb.set] : [sb.set, sa.set]; for (const k of small) if (big.has(k)) inter++;
      const overlap = small.size ? inter / small.size : 0, uniq = Math.min(sa.unique, sb.unique);
      return { cols, overlap: round(overlap, 4), uniqueA: round(sa.unique, 4), uniqueB: round(sb.unique, 4), dupA: sa.dup, dupB: sb.dup, shared: inter, score: round(0.5 * overlap + 0.3 * uniq + bonus, 4) };
    };
    const singles = [];
    for (const p of pairs) {
      const kind = kindOf(A, p.a); if (kind === 'empty') continue;
      const sa = keyStats(A, [p.a]); if (sa.unique < 0.95 || sa.nulls > 0.02) continue;
      const sb = keyStats(B, [p.b]); if (sb.unique < 0.95 || sb.nulls > 0.02) continue;
      const bonus = (ID_NAME.test(p.nameA) || ID_NAME.test(p.nameB) ? 0.2 : 0) + (p.a === 0 ? 0.05 : 0) - (kind === 'decimal' ? 0.35 : kind === 'date' ? 0.2 : 0);
      const r = score([p], sa, sb, bonus); r.why = keyWhy(r); out.push(r); singles.push(p);
    }
    if (!out.some(k => k.score >= 0.75)) {
      // Two columns together (for example store + date) when no single column identifies a row.
      const cands = pairs.filter(p => kindOf(A, p.a) !== 'decimal').map(p => ({ p, s: keyStats(A, [p.a]) })).filter(x => x.s.nulls <= 0.02 && x.s.unique > 0.02).sort((x, y) => y.s.unique - x.s.unique).slice(0, 6).map(x => x.p);
      for (let i = 0; i < cands.length; i++) for (let j = i + 1; j < cands.length; j++) {
        const pa = [cands[i], cands[j]], sa = keyStats(A, pa.map(p => p.a)); if (sa.unique < 0.99) continue;
        const sb = keyStats(B, pa.map(p => p.b)); if (sb.unique < 0.99) continue;
        const bonus = pa.some(p => ID_NAME.test(p.nameA)) ? 0.1 : 0;
        const r = score(pa, sa, sb, bonus - 0.05); r.why = keyWhy(r); out.push(r);
      }
    }
    return out.sort((x, y) => y.score - x.score).slice(0, 6).map(k => ({ ...k, names: k.cols.map(p => p.nameA), namesB: k.cols.map(p => p.nameB) }));
  }
  function keyWhy(k) {
    const u = Math.min(k.uniqueA, k.uniqueB);
    return `${u >= 0.9999 ? 'Unique' : (u * 100).toFixed(1) + '% unique'} in both; ${(k.overlap * 100).toFixed(k.overlap > 0.999 || k.overlap < 0.001 ? 0 : 1)}% of values appear in both`;
  }

  /* ---------- Cell comparison ---------- */
  function makeEq(o) {
    const nrm = (v) => { let s = txt(v); if (o.ignoreSpace) s = s.trim().replace(/\s+/g, ' '); if (o.ignoreCase) s = s.toLowerCase(); return s; };
    return (a, b) => {
      if (a === b) return true;
      const na = isNull(a), nb = isNull(b);
      if (na || nb) return na && nb && (o.nulls || txt(a) === txt(b));
      const x = nrm(a), y = nrm(b); if (x === y) return true;
      if (o.numeric) { const p = Q().toNumber(x), q = Q().toNumber(y); if (p !== null && q !== null) return Math.abs(p - q) <= (o.tol || 0) + 1e-9 * Math.max(1, Math.abs(p), Math.abs(q)); }
      return false;
    };
  }
  // Numeric for deltas and totals: parses as a number, and isn't an identifier, phone, postcode or year written in digits.
  const NOT_MEASURE = /(phone|mobile|tel|fax|zip|postal|post ?code|year|lat|lon|lng|(^|_| )(id|key|code|no|number)$)/i;
  const isNumCol = (t, ci) => { if (NOT_MEASURE.test(t.columns[ci])) return false; const v = sampleVals(t, ci, 300); return v.length >= 3 && v.filter(x => Q().looseNumber(x) !== null && !/\d\s+\d/.test(x)).length / v.length >= 0.9; };
  const MONEY = /(total|amount|revenue|sales|price|cost|value|balance|spend|paid|fee|qty|quantity|units|count|income|profit)/i;

  // Accumulates per-column changes; shared by both modes so the screens read one shape.
  function colTracker(pairs, A, B) {
    return pairs.map(p => ({ ...p, changed: 0, nullToValue: 0, valueToNull: 0, caseOnly: 0, spaceOnly: 0, formatOnly: 0, trans: new Map(), num: isNumCol(A, p.a) && isNumCol(B, p.b), up: 0, down: 0, sumDelta: 0, nDelta: 0, relSum: 0, nRel: 0, maxAbs: 0, steps: new Map() }));
  }
  function track(c, va, vb, step) {
    c.changed++;
    const na = isNull(va), nb = isNull(vb);
    if (na && !nb) c.nullToValue++; else if (!na && nb) c.valueToNull++;
    else if (!na && !nb) {
      const x = txt(va), y = txt(vb), sx = x.trim().replace(/\s+/g, ' '), sy = y.trim().replace(/\s+/g, ' ');
      if (sx === sy) c.spaceOnly++; else if (sx.toLowerCase() === sy.toLowerCase()) c.caseOnly++;
      else { const p = Q().toNumber(x), q = Q().toNumber(y); if (p !== null && p === q) c.formatOnly++; }
    }
    if (c.trans.size < 5000 || c.trans.has(txt(va) + '\u0001' + txt(vb))) { const k = txt(va) + '\u0001' + txt(vb); c.trans.set(k, (c.trans.get(k) || 0) + 1); }
    if (c.num && !na && !nb) {
      const x = Q().looseNumber(va), y = Q().looseNumber(vb);
      if (x !== null && y !== null && x !== y) { const d = y - x; c.sumDelta += d; c.nDelta++; if (d > 0) c.up++; else c.down++; if (Math.abs(d) > Math.abs(c.maxAbs)) c.maxAbs = d; if (x !== 0) { c.relSum += d / Math.abs(x); c.nRel++; } }
    }
    if (step !== undefined && step >= 0) c.steps.set(step, (c.steps.get(step) || 0) + 1);
  }
  function finishCols(cols, matched) {
    return cols.map(c => {
      const top = [...c.trans].sort((x, y) => y[1] - x[1]).slice(0, 6).map(([k, n]) => { const [from, to] = k.split('\u0001'); return { from, to, n }; });
      return { a: c.a, b: c.b, nameA: c.nameA, nameB: c.nameB, how: c.how, renamedBy: c.renamedBy, changed: c.changed, pct: matched ? c.changed / matched : 0, nullToValue: c.nullToValue, valueToNull: c.valueToNull, caseOnly: c.caseOnly, spaceOnly: c.spaceOnly, formatOnly: c.formatOnly, distinctChanges: c.trans.size, top, numeric: c.num,
        delta: c.nDelta ? { n: c.nDelta, up: c.up, down: c.down, mean: c.sumDelta / c.nDelta, sum: c.sumDelta, meanPct: c.nRel ? c.relSum / c.nRel : null, maxAbs: c.maxAbs } : null,
        steps: [...c.steps].sort((x, y) => y[1] - x[1]).map(([i, n]) => ({ i, n })) };
    });
  }
  // Sum of numeric columns before and after, split into what added rows, removed rows and edited values contributed.
  function totalsFor(cols, A, B, list) {
    const rank = (n) => (/(total|amount|revenue|sales|balance|spend|paid|income|profit|fee)/i.test(n) ? 2 : MONEY.test(n) ? 1 : 0);
    const pick = cols.filter(c => c.num).sort((x, y) => rank(y.nameB) - rank(x.nameB)).slice(0, 6);
    if (!pick.length) return [];
    const L = (v) => { const n = Q().looseNumber(v); return n === null ? 0 : n; };
    return pick.map(c => {
      let before = 0, after = 0; for (const r of A.rows) before += L(r[c.a]); for (const r of B.rows) after += L(r[c.b]);
      let added = 0, removed = 0;
      for (const x of list.added) added += L(B.rows[x][c.b]);
      for (const x of list.removed) removed += L(A.rows[x][c.a]);
      const r8 = (x) => Math.round(x * 1e8) / 1e8;
      return { column: c.nameB, columnA: c.nameA, before: r8(before), after: r8(after), added: r8(added), removed: r8(-removed), edited: r8(after - before - added + removed) };
    }).filter(t => [t.after - t.before, t.added, t.removed, t.edited].some(x => Math.abs(x) > 1e-9 * Math.max(1, Math.abs(t.before))));
  }

  /* ---------- Two tables ---------- */
  // opts: { key: [names in A] | null, match: 'key' | 'rows' | 'position', numeric, nulls, ignoreCase, ignoreSpace, tol, maxList }
  function diffTables(A, B, opts = {}) {
    const o = { numeric: true, nulls: true, ignoreCase: false, ignoreSpace: false, tol: 0, maxList: 100000, ...opts };
    const t0 = Date.now(), cm = opts.columns || matchColumns(A, B), eq = makeEq(o);
    let keys = opts.keys; if (keys === undefined) keys = findKeys(A, B, cm.pairs);
    let match = o.match, key = null;
    if (!match) { if (o.key && o.key.length) match = 'key'; else if (keys[0] && keys[0].score >= 0.55 && keys[0].overlap >= 0.2) { match = 'key'; key = keys[0]; } else match = 'rows'; }
    if (match === 'key' && !key) {
      const names = o.key || (keys[0] && keys[0].names) || [];
      const ps = names.map(n => cm.pairs.find(p => p.nameA === n)).filter(Boolean);
      if (ps.length && ps.length === names.length) key = keys.find(k => k.names.join('\u0001') === names.join('\u0001')) || { cols: ps, names, namesB: ps.map(p => p.nameB) };
      else match = 'rows';
    }
    const cols = colTracker(cm.pairs, A, B);
    const pairsIdx = cm.pairs.map((_, i) => i);
    const matchedA = new Int32Array(A.rows.length).fill(-1), matchedB = new Uint8Array(B.rows.length);
    let dupKeysA = 0, dupKeysB = 0, nullKeys = 0;
    if (match === 'key') {
      const ia = key.cols.map(p => p.a), ib = key.cols.map(p => p.b);
      const kOf = (r, idx) => (idx.some(i => isNull(r[i])) ? null : idx.map(i => keyText(r[i])).join('\u0001'));
      const map = new Map();
      B.rows.forEach((r, j) => { const k = kOf(r, ib); if (k === null) return; const l = map.get(k); if (l) { if (l.length === 1) dupKeysB++; l.push(j); } else map.set(k, [j]); });
      const seenA = new Set();
      A.rows.forEach((r, i) => {
        const k = kOf(r, ia); if (k === null) { nullKeys++; return; }
        if (seenA.has(k)) dupKeysA++; else seenA.add(k);
        const l = map.get(k); if (l && l.length) { const j = l.shift(); matchedA[i] = j; matchedB[j] = 1; }
      });
    } else if (match === 'position') {
      const n = Math.min(A.rows.length, B.rows.length); for (let i = 0; i < n; i++) { matchedA[i] = i; matchedB[i] = 1; }
    }
    if (match === 'rows' || nullKeys) {
      // Whole-row matching: identical rows (under the comparison options) pair up; everything else is added or removed.
      const sig = (r, side) => cm.pairs.map(p => { const v = r[side === 'a' ? p.a : p.b]; if (isNull(v)) return o.nulls ? '\u0000' : txt(v); let s = txt(v); if (o.ignoreSpace) s = s.trim().replace(/\s+/g, ' '); if (o.ignoreCase) s = s.toLowerCase(); if (o.numeric) { const n = Q().toNumber(s); if (n !== null) s = '#' + n; } return s; }).join('\u0001');
      const map = new Map();
      B.rows.forEach((r, j) => { if (matchedB[j]) return; const k = sig(r, 'b'); const l = map.get(k); if (l) l.push(j); else map.set(k, [j]); });
      A.rows.forEach((r, i) => { if (matchedA[i] >= 0) return; const l = map.get(sig(r, 'a')); if (l && l.length) { const j = l.shift(); matchedA[i] = j; matchedB[j] = 1; } });
    }
    const list = { changed: [], added: [], removed: [] }; let changedCells = 0, unchanged = 0, matched = 0;
    for (let i = 0; i < A.rows.length; i++) {
      const j = matchedA[i]; if (j < 0) { list.removed.push(i); continue; }
      matched++; const ra = A.rows[i], rb = B.rows[j]; let cells = null;
      for (const k of pairsIdx) { const c = cols[k], va = ra[c.a], vb = rb[c.b]; if (!eq(va, vb)) { (cells || (cells = [])).push(k); track(c, va, vb); } }
      if (cells) { changedCells += cells.length; list.changed.push({ a: i, b: j, cells }); } else unchanged++;
    }
    for (let j = 0; j < B.rows.length; j++) if (!matchedB[j]) list.added.push(j);
    const res = {
      mode: 'tables', match, key: key ? { names: key.names, namesB: key.namesB, why: key.why } : null, keys,
      columns: { pairs: cm.pairs, added: cm.added, removed: cm.removed, renamed: cm.pairs.filter(p => p.how === 'renamed') },
      counts: { rowsA: A.rows.length, rowsB: B.rows.length, matched, changed: list.changed.length, added: list.added.length, removed: list.removed.length, unchanged, changedCells, dupKeysA, dupKeysB, nullKeys },
      cols: finishCols(cols, matched), totals: totalsFor(cols, A, B, list), list: capList(list, o.maxList), options: pickOpts(o), ms: Date.now() - t0
    };
    res.summary = summarize(res);
    return res;
  }
  const pickOpts = (o) => ({ numeric: !!o.numeric, nulls: !!o.nulls, ignoreCase: !!o.ignoreCase, ignoreSpace: !!o.ignoreSpace, tol: +o.tol || 0 });
  function capList(l, max) {
    const total = l.changed.length + l.added.length + l.removed.length; if (total <= max) return { ...l, truncated: false };
    const f = max / total; return { changed: l.changed.slice(0, Math.ceil(l.changed.length * f)), added: l.added.slice(0, Math.ceil(l.added.length * f)), removed: l.removed.slice(0, Math.ceil(l.removed.length * f)), truncated: true };
  }

  /* ---------- A dataset's own pipeline, step by step ---------- */
  // Runs the steps on a copy of the rows with in-place edits, so each row keeps its identity from step to step. That
  // tells us exactly which source row became which output row, and which step removed a row or last changed a cell.
  function tracePipeline(base, steps, opts = {}) {
    const o = { numeric: false, nulls: false, ignoreCase: false, ignoreSpace: false, tol: 0, maxList: 100000, ...opts };
    const t0 = Date.now(), QE = Q(), n = base.rows.length, W = base.columns.length;
    let t = { columns: [...base.columns], rows: base.rows.map(r => r.slice()) };
    const rid = new WeakMap(); t.rows.forEach((r, i) => rid.set(r, i));
    let cids = base.columns.map((_, i) => i), nextCid = W;
    const colBorn = new Map(), colName0 = base.columns.slice(), renamedBy = new Map(), droppedBy = new Map();
    const removedBy = new Int16Array(n).fill(-1);
    const lastStep = new Map(), firstStep = new Map(); // cid -> Int16Array(n)
    const stepStats = [];
    let reordered = -1;
    QE.setInPlace(true);
    try {
      steps.forEach((s, si) => {
        const op = QE.OPS[s.op], st = { i: si, id: s.id, op: s.op, label: op ? op.describe(s.params || {}) : s.op, disabled: !!s.disabled, rowsBefore: t.rows.length, rowsRemoved: 0, cells: 0, byCol: new Map(), colsAdded: [], colsRemoved: [], renamed: [], error: null };
        stepStats.push(st);
        if (s.disabled || !op) { if (!op && !s.disabled) st.error = 'Unknown operation ' + s.op; return; }
        const prevRows = t.rows.slice(), prevVals = prevRows.map(r => r.slice()), prevCols = t.columns.slice(), prevCids = cids.slice();
        let r;
        try { r = op.apply(t, s.params || {}); } catch (e) {
          st.error = e.message; prevRows.forEach((row, k) => { row.length = 0; row.push(...prevVals[k]); }); t = { columns: prevCols, rows: prevRows }; return;
        }
        const nt = r.table;
        // Column identity: same count → positional (renames), otherwise by name, new names get new ids.
        let ncids;
        if (nt.columns.length === prevCols.length) ncids = prevCids.slice();
        else {
          const used = new Set(); ncids = nt.columns.map(c => { const k = prevCols.findIndex((p, x) => p === c && !used.has(x)); if (k >= 0) { used.add(k); return prevCids[k]; } return -1; });
          ncids = ncids.map((c, x) => { if (c >= 0) return c; const id = nextCid++; colBorn.set(id, si); st.colsAdded.push(nt.columns[x]); return id; });
        }
        const keep = new Set(ncids); prevCids.forEach((c, x) => { if (!keep.has(c)) { st.colsRemoved.push(prevCols[x]); if (c < W) droppedBy.set(c, si); } });
        ncids.forEach((c, x) => { const k = prevCids.indexOf(c); if (k >= 0 && prevCols[k] !== nt.columns[x]) { st.renamed.push([prevCols[k], nt.columns[x]]); renamedBy.set(c, si); } });
        const prevPos = new Map(prevCids.map((c, x) => [c, x]));
        const alive = new Set(nt.rows);
        for (const row of prevRows) if (!alive.has(row)) { removedBy[rid.get(row)] = si; st.rowsRemoved++; }
        const prevIdx = new Map(); prevRows.forEach((row, k) => prevIdx.set(row, k));
        let inOrder = true, last = -1;
        for (const row of nt.rows) {
          const k = prevIdx.get(row); if (k === undefined) continue; if (k < last) inOrder = false; last = k;
          const pv = prevVals[k], id = rid.get(row);
          for (let x = 0; x < ncids.length; x++) {
            const c = ncids[x], px = prevPos.get(c); if (px === undefined) continue;
            const a = pv[px], b = row[x]; if (a === b || txt(a) === txt(b)) continue;
            st.cells++; st.byCol.set(nt.columns[x], (st.byCol.get(nt.columns[x]) || 0) + 1);
            if (c < W) { let L = lastStep.get(c); if (!L) { L = new Int16Array(n).fill(-1); lastStep.set(c, L); firstStep.set(c, new Int16Array(n).fill(-1)); } L[id] = si; const F = firstStep.get(c); if (F[id] < 0) F[id] = si; }
          }
        }
        if (!inOrder && reordered < 0) reordered = si;
        t = nt; cids = ncids;
      });
    } finally { QE.setInPlace(false); }
    const out = t;
    // Build the same result shape as diffTables: source columns that survive pair with their output column.
    const pairs = [], outPos = new Map(cids.map((c, x) => [c, x]));
    for (let c = 0; c < W; c++) { const x = outPos.get(c); if (x === undefined) continue; pairs.push({ a: c, b: x, nameA: colName0[c], nameB: out.columns[x], how: colName0[c] === out.columns[x] ? 'same' : 'renamed', renamedBy: renamedBy.get(c), cid: c }); }
    pairs.sort((x, y) => x.b - y.b);
    const added = cids.map((c, x) => (c >= W ? { name: out.columns[x], step: colBorn.get(c) } : null)).filter(Boolean);
    const removedCols = [...Array(W).keys()].filter(c => !outPos.has(c)).map(c => ({ name: colName0[c], step: droppedBy.get(c) }));
    const cols = colTracker(pairs, base, out); cols.forEach((c, k) => { c.renamedBy = pairs[k].renamedBy; });
    const eq = makeEq(o), list = { changed: [], added: [], removed: [] };
    const outOf = new Int32Array(n).fill(-1); out.rows.forEach((row, j) => { outOf[rid.get(row)] = j; });
    let matched = 0, unchanged = 0, changedCells = 0;
    for (let i = 0; i < n; i++) {
      const j = outOf[i]; if (j < 0) { list.removed.push(i); continue; }
      matched++; const ra = base.rows[i], rb = out.rows[j]; let cells = null, by = null;
      for (let k = 0; k < pairs.length; k++) {
        const p = pairs[k], va = ra[p.a], vb = rb[p.b]; if (eq(va, vb)) continue;
        const L = lastStep.get(p.cid), F = firstStep.get(p.cid), ls = L ? L[i] : -1, fs = F ? F[i] : -1;
        (cells || (cells = [])).push(k); (by || (by = [])).push(fs === ls ? ls : [fs, ls]); track(cols[k], va, vb, ls);
      }
      if (cells) { changedCells += cells.length; list.changed.push({ a: i, b: j, cells, by }); } else unchanged++;
    }
    const removedStep = (i) => removedBy[i];
    stepStats.forEach(st => { st.byCol = [...st.byCol].sort((x, y) => y[1] - x[1]).map(([column, n]) => ({ column, n })); });
    const res = {
      mode: 'pipeline', match: 'lineage', key: null, keys: [], table: out,
      columns: { pairs, added: added.map(x => x.name), removed: removedCols.map(x => x.name), addedBy: added, removedBy: removedCols, renamed: pairs.filter(p => p.how === 'renamed') },
      counts: { rowsA: n, rowsB: out.rows.length, matched, changed: list.changed.length, added: 0, removed: list.removed.length, unchanged, changedCells, dupKeysA: 0, dupKeysB: 0, nullKeys: 0 },
      cols: finishCols(cols, matched), totals: totalsFor(cols, base, out, { added: [], removed: list.removed }), list: capList(list, o.maxList), options: pickOpts(o),
      steps: stepStats, removedStep, reordered, ms: Date.now() - t0
    };
    res.summary = summarize(res);
    return res;
  }

  /* ---------- Plain-English summary ---------- */
  const fmtN = (x) => Number(x).toLocaleString('en-US', { maximumFractionDigits: Math.abs(x) >= 100 ? 0 : 2 });
  const shown = (s) => (s === '' ? 'empty' : '"' + (s.length > 24 ? s.slice(0, 23) + '…' : s) + '"');
  function summarize(r) {
    const c = r.counts, out = [];
    if (!c.changed && !c.added && !c.removed && !r.columns.added.length && !r.columns.removed.length && !r.columns.renamed.length) return ['The two versions are identical' + (r.options.numeric || r.options.nulls ? ' under the current comparison settings.' : '.')];
    const parts = [];
    if (c.changed) parts.push(`${fmtN(c.changed)} row${c.changed > 1 ? 's' : ''} changed (${fmtN(c.changedCells)} cell${c.changedCells > 1 ? 's' : ''})`);
    if (c.added) parts.push(`${fmtN(c.added)} added`);
    if (c.removed) parts.push(`${fmtN(c.removed)} removed`);
    if (parts.length) out.push(parts.join(', ') + `, ${fmtN(c.unchanged)} unchanged.`);
    if (r.mode === 'tables' && !c.matched && c.rowsA && c.rowsB) out.push('No row appears in both, so these look like different records rather than two versions of the same rows. The column statistics compare them as a whole.');
    const top = r.cols.filter(x => x.changed).sort((x, y) => y.changed - x.changed).slice(0, 3);
    for (const x of top) {
      let s = `${x.nameB}: ${fmtN(x.changed)} rows`;
      if (x.delta && x.delta.n >= x.changed * 0.6) s += x.delta.meanPct !== null && Math.abs(x.delta.meanPct) < 50 ? `, average ${x.delta.meanPct >= 0 ? '+' : ''}${(x.delta.meanPct * 100).toFixed(1)}% (${fmtN(x.delta.up)} up, ${fmtN(x.delta.down)} down)` : `, average change ${x.delta.mean >= 0 ? '+' : ''}${fmtN(x.delta.mean)}`;
      else if (x.top[0] && x.top[0].n >= 2 && x.top[0].n >= x.changed * 0.1) s += `, mostly ${shown(x.top[0].from)} → ${shown(x.top[0].to)} (${fmtN(x.top[0].n)})`;
      if (x.distinctChanges >= x.changed * 0.9 && x.changed >= 20 && !x.caseOnly && !x.delta) s += ', almost every value replaced with a different one';
      else if (x.caseOnly >= x.changed * 0.9) s += r.mode === 'tables' ? ', only letter case differs (turn on Ignore case to hide these)' : ', only letter case changed';
      else if (x.spaceOnly >= x.changed * 0.9) s += ', only spacing differs';
      else if (x.formatOnly >= x.changed * 0.9) s += ', same numbers written differently';
      else if (x.nullToValue >= x.changed * 0.5) s += ', mostly missing values filled in';
      else if (x.valueToNull >= x.changed * 0.5) s += ', mostly values emptied';
      out.push(s + '.');
    }
    if (r.mode === 'pipeline') {
      const live = r.steps.filter(s => !s.disabled && !s.error);
      const big = live.filter(s => s.cells).sort((x, y) => y.cells - x.cells)[0], cut = live.filter(s => s.rowsRemoved).sort((x, y) => y.rowsRemoved - x.rowsRemoved)[0];
      if (big && live.filter(s => s.cells).length > 1) out.push(`Most edits came from step ${big.i + 1} (${big.label}): ${fmtN(big.cells)} cells.`);
      if (cut) out.push(`Step ${cut.i + 1} (${cut.label}) removed ${fmtN(cut.rowsRemoved)} row${cut.rowsRemoved > 1 ? 's' : ''}${live.filter(s => s.rowsRemoved).length > 1 ? `; ${fmtN(c.removed - cut.rowsRemoved)} more by other steps` : ''}.`);
      const idle = live.filter(s => !s.cells && !s.rowsRemoved && !s.colsAdded.length && !s.colsRemoved.length && !s.renamed.length && s.i !== r.reordered);
      if (idle.length) out.push(`Step${idle.length > 1 ? 's' : ''} ${idle.map(s => s.i + 1).join(', ')} changed nothing in this data.`);
      const err = r.steps.filter(s => s.error); if (err.length) out.push(`Step${err.length > 1 ? 's' : ''} ${err.map(s => s.i + 1).join(', ')} failed and ${err.length > 1 ? 'were' : 'was'} skipped.`);
    }
    if (r.columns.renamed.length) out.push('Renamed: ' + r.columns.renamed.map(p => `${p.nameA} → ${p.nameB}`).join(', ') + '.');
    if (r.columns.added.length) out.push('New column' + (r.columns.added.length > 1 ? 's' : '') + ': ' + r.columns.added.join(', ') + '.');
    if (r.columns.removed.length) out.push('Column' + (r.columns.removed.length > 1 ? 's' : '') + ' gone: ' + r.columns.removed.join(', ') + '.');
    const t = (r.totals || []).find(x => Math.abs(x.after - x.before) > 1e-9 && MONEY.test(x.column));
    if (t) {
      const d = t.after - t.before, bits = [['new rows', t.added], ['removed rows', t.removed], ['edited values', t.edited]].filter(b => Math.abs(b[1]) > 1e-9 * Math.max(1, Math.abs(t.before))).map(([k, v]) => `${v >= 0 ? '+' : '−'}${fmtN(Math.abs(v))} from ${k}`);
      out.push(`Sum of ${t.column} ${d >= 0 ? 'rose' : 'fell'} ${fmtN(Math.abs(d))}${t.before ? ` (${d >= 0 ? '+' : ''}${(d / Math.abs(t.before) * 100).toFixed(1)}%)` : ''}: ${bits.join(', ')}.`);
    }
    if (c.dupKeysA || c.dupKeysB) out.push(`The key repeats (${fmtN(c.dupKeysA)} before, ${fmtN(c.dupKeysB)} after); repeated keys were paired in file order.`);
    return out;
  }

  /* ---------- Change log export ---------- */
  function changeLog(r, A, B, { stepLabel } = {}) {
    const esc = (v) => { const s = txt(v); return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
    const pairs = r.columns.pairs, keyIdx = r.key ? r.key.names.map(n => A.columns.indexOf(n)) : null;
    const keyA = (i) => (keyIdx ? keyIdx.map(x => txt(A.rows[i][x])).join(' / ') : 'row ' + (i + 1));
    const keyB = (j) => (r.key ? r.key.namesB.map(n => txt(B.rows[j][B.columns.indexOf(n)])).join(' / ') : 'row ' + (j + 1));
    const lines = [['key', 'status', 'column', 'before', 'after', ...(r.mode === 'pipeline' ? ['changed_by_step'] : [])].join(',')];
    const sl = (x) => (x === undefined || x < 0 ? '' : stepLabel ? stepLabel(x) : 'step ' + (x + 1));
    for (const ch of r.list.changed) ch.cells.forEach((k, n) => { const p = pairs[k]; const by = ch.by ? ch.by[n] : undefined; lines.push([keyA(ch.a), 'changed', p.nameB, A.rows[ch.a][p.a], B.rows[ch.b][p.b], ...(r.mode === 'pipeline' ? [Array.isArray(by) ? sl(by[0]) + ' … ' + sl(by[1]) : sl(by)] : [])].map(esc).join(',')); });
    for (const i of r.list.removed) lines.push([keyA(i), 'removed', '', A.rows[i].map(txt).join(' | '), '', ...(r.mode === 'pipeline' ? [sl(r.removedStep(i))] : [])].map(esc).join(','));
    for (const j of r.list.added) lines.push([keyB(j), 'added', '', '', B.rows[j].map(txt).join(' | ')].map(esc).join(','));
    return lines.join('\n');
  }

  G.QDiff = { matchColumns, findKeys, diffTables, tracePipeline, changeLog, nameSim, summarize };
})();
