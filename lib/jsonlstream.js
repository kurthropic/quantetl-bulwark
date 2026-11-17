// Streaming JSONL / NDJSON reader (plain or .gz) with the same { columns, rows } batch interface as readCSV.
// Records are flattened exactly as the console's parseJSONL does (QETL.flattenRecord). The column set must be fixed
// for every batch, so it is the union of keys over the whole file: found by scanColumns() in a first pass, unless the
// caller already knows it.
'use strict';
const fs = require('fs');
const zlib = require('zlib');
const { StringDecoder } = require('string_decoder');
const QETL = require('./qetl');

const isGz = (f) => /\.gz$/i.test(f);
const isJSONL = (name) => /\.(jsonl|ndjson)(\.gz)?$/i.test(name || '');

async function* lines(file, onBytes, range) { // yields [lineNumber, text] for non-blank lines; range: { start, end } bytes (end exclusive)
  const raw = fs.createReadStream(file, { highWaterMark: 1 << 20, ...(range && range.start !== undefined ? { start: range.start, end: range.end - 1 } : {}) });
  let bytes = 0; raw.on('data', (c) => { bytes += c.length; });
  const s = isGz(file) ? raw.pipe(zlib.createGunzip({ chunkSize: 1 << 20 })) : raw;
  const dec = new StringDecoder('utf8'); let rest = '', n = 0, first = true;
  for await (const chunk of s) {
    let text = rest + dec.write(chunk);
    if (first) { text = text.replace(/^﻿/, ''); first = false; }
    let start = 0, end;
    while ((end = text.indexOf('\n', start)) >= 0) { n++; const l = text.slice(start, end); start = end + 1; if (l.trim()) yield [n, l]; }
    rest = text.slice(start);
    if (onBytes) onBytes(bytes);
  }
  rest += dec.end(); if (rest.trim()) yield [n + 1, rest];
  if (onBytes) onBytes(bytes);
}
function parseLine(n, l) {
  let v; try { v = JSON.parse(l); } catch (e) { throw new Error(`Line ${n} is not valid JSON (${e.message.replace(/^JSON\.parse: |^Unexpected /, '')}).`); }
  return QETL.flattenRecord(v);
}

/** Union of flattened keys, in order of first appearance. */
async function scanColumns(file, onBytes) {
  const cols = [], set = new Set();
  for await (const [n, l] of lines(file, onBytes)) { const o = parseLine(n, l); for (const k in o) if (!set.has(k)) { set.add(k); cols.push(k); } }
  if (!cols.length) throw new Error('The file is empty.');
  return cols;
}

/** opts: batch (default 50,000), columns (skip the key scan), onBytes, onScan(bytes) for the scan pass. */
async function* readJSONL(file, opts = {}) {
  const batch = opts.batch || 50000;
  const columns = opts.columns || await scanColumns(file, opts.onScan);
  let out = [];
  for await (const [n, l] of lines(file, opts.onBytes, opts.start !== undefined ? { start: opts.start, end: opts.end } : null)) {
    const o = parseLine(n, l), r = new Array(columns.length);
    for (let c = 0; c < columns.length; c++) { const v = o[columns[c]]; r[c] = v === undefined ? '' : v; }
    out.push(r);
    if (out.length >= batch) { yield { columns, rows: out }; out = []; }
  }
  yield { columns, rows: out };
}

/** Splits a plain (not gzipped) JSONL file into up to n byte ranges that start and end on line boundaries. */
function splitRanges(file, n) {
  const size = fs.statSync(file).size, fd = fs.openSync(file, 'r'), cuts = [0], buf = Buffer.alloc(1 << 16);
  try {
    for (let i = 1; i < n; i++) {
      let p = Math.floor(size * i / n); if (p <= cuts[cuts.length - 1]) continue;
      for (;;) { const got = fs.readSync(fd, buf, 0, buf.length, p); if (!got) { p = size; break; } const j = buf.indexOf(10, 0); if (j >= 0 && j < got) { p += j + 1; break; } p += got; }
      if (p < size && p > cuts[cuts.length - 1]) cuts.push(p);
    }
  } finally { fs.closeSync(fd); }
  cuts.push(size);
  return cuts.slice(0, -1).map((s, i) => ({ start: s, end: cuts[i + 1] })).filter(r => r.end > r.start);
}

module.exports = { readJSONL, scanColumns, isJSONL, splitRanges };
