// Streaming CSV/TSV reader for large files. Same rules as parseCSV() in js/etl.js (BOM, CRLF or CR line ends,
// quotes only at the start of a field, "" escapes, blank lines skipped, header trimmed and de-duplicated, rows padded
// or cut to the header width), but works chunk by chunk so a multi-GB file never has to fit in memory.
'use strict';
const fs = require('fs');
const zlib = require('zlib');
const { StringDecoder } = require('string_decoder');

class CSVParser {
  constructor(delimiter) { this.d = delimiter; this.row = []; this.field = ''; this.q = false; this.quoteEnd = false; this.cr = false; this.rows = []; }
  // Feeds a string chunk; complete rows are appended to this.rows.
  push(text) {
    const dc = this.d.charCodeAt(0), n = text.length; let i = 0, row = this.row, field = this.field;
    if (this.cr) { this.cr = false; if (n && text.charCodeAt(0) === 10) i = 1; }           // \r at the end of the last chunk
    if (this.quoteEnd) { this.quoteEnd = false; if (n && text[0] === '"') { field += '"'; i = 1; } else this.q = false; } // " at the end of the last chunk
    while (i < n) {
      if (this.q) {
        const j = text.indexOf('"', i);
        if (j < 0) { field += text.slice(i); i = n; break; }
        field += text.slice(i, j);
        if (j + 1 >= n) { this.quoteEnd = true; i = n; break; }
        if (text[j + 1] === '"') { field += '"'; i = j + 2; } else { this.q = false; i = j + 1; }
        continue;
      }
      const c = text.charCodeAt(i);
      if (c === 34 && field === '') { this.q = true; i++; continue; }           // "
      if (c === dc) { row.push(field); field = ''; i++; continue; }
      if (c === 10 || c === 13) {                                              // \n or \r
        if (c === 13) { if (i + 1 >= n) this.cr = true; else if (text.charCodeAt(i + 1) === 10) i++; }
        row.push(field); field = '';
        if (row.length > 1 || row[0] !== '') this.rows.push(row);
        row = []; i++; continue;
      }
      // plain run of characters up to the next delimiter or line end (a quote here is literal)
      let j = i + 1;
      while (j < n) { const x = text.charCodeAt(j); if (x === dc || x === 10 || x === 13) break; j++; }
      field += text.slice(i, j); i = j;
    }
    this.row = row; this.field = field;
  }
  end() {
    if (this.quoteEnd) { this.quoteEnd = false; this.q = false; }
    if (this.field !== '' || this.row.length) { this.row.push(this.field); this.rows.push(this.row); }
    this.row = []; this.field = '';
  }
  take() { const r = this.rows; this.rows = []; return r; }
}

const isGz = (file) => /\.gz$/i.test(file);
function openText(file, { start } = {}) {
  let s = fs.createReadStream(file, { highWaterMark: 1 << 20 });
  if (isGz(file)) s = s.pipe(zlib.createGunzip({ chunkSize: 1 << 20 }));
  return s;
}

// Reads the first ~64 KB of text (decompressed) to detect the delimiter the same way detectDelimiter() does.
async function headText(file, bytes = 65536) {
  const s = openText(file); const dec = new StringDecoder('utf8'); let text = '';
  for await (const chunk of s) { text += dec.write(chunk); if (text.length >= bytes) break; }
  s.destroy();
  return text.replace(/^﻿/, '');
}

/**
 * Yields { columns, rows } batches of up to `batch` rows. `columns` is the cleaned header (same as parseCSV).
 * opts: delimiter, batch (default 50,000), onBytes(bytesRead) for progress.
 */
async function* readCSV(file, opts = {}) {
  const batch = opts.batch || 50000;
  const p = new CSVParser(opts.delimiter);
  const raw = fs.createReadStream(file, { highWaterMark: 1 << 20 });
  let bytes = 0; raw.on('data', (c) => { bytes += c.length; });
  const s = isGz(file) ? raw.pipe(zlib.createGunzip({ chunkSize: 1 << 20 })) : raw;
  const dec = new StringDecoder('utf8');
  let columns = null, w = 0, first = true;
  const shape = (r) => { if (r.length === w) return r; const o = r.slice(0, w); while (o.length < w) o.push(''); return o; };
  let out = [];
  const drain = function* () {
    let rows = p.take();
    if (!columns && rows.length) {
      const header = rows.shift().map((h, i) => h.trim() || 'column_' + (i + 1)); const seen = {};
      columns = header.map(h => { if (seen[h]) { seen[h]++; return h + '_' + seen[h]; } seen[h] = 1; return h; }); w = columns.length;
    }
    for (const r of rows) { out.push(shape(r)); if (out.length >= batch) { const b = out; out = []; yield b; } }
  };
  for await (const chunk of s) {
    let text = dec.write(chunk);
    if (first) { text = text.replace(/^﻿/, ''); first = false; }
    p.push(text);
    for (const b of drain()) { if (opts.onBytes) opts.onBytes(bytes); yield { columns, rows: b }; }
  }
  const tail = dec.end(); if (tail) p.push(tail);
  p.end();
  for (const b of drain()) yield { columns, rows: b };
  if (!columns) throw new Error('The file is empty.');
  if (opts.onBytes) opts.onBytes(bytes);
  yield { columns, rows: out };
}

module.exports = { CSVParser, readCSV, headText, isGz };
