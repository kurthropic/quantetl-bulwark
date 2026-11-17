// Parquet reader and writer in plain JavaScript (Node built-ins only), for QuantETL's large-dataset path.
//
// Reader: flat schemas (top-level columns, no nested groups or repeated fields), data pages v1 and v2, dictionary
// pages, PLAIN / PLAIN_DICTIONARY / RLE_DICTIONARY values, RLE / bit-packed levels; codecs UNCOMPRESSED, SNAPPY,
// GZIP, BROTLI and ZSTD. Logical types STRING, ENUM, JSON, UUID, DATE, TIME, TIMESTAMP, DECIMAL and INTEGER (signed and
// unsigned widths), plus legacy INT96 timestamps. Anything else is refused with a message naming the column.
//
// Writer: one OPTIONAL column per table column, PLAIN encoding, v1 data pages, ZSTD compression (GZIP fallback),
// a row group every 100,000 rows. Column types are decided from the values (see decideTypes).
'use strict';
const fs = require('fs');
const zlib = require('zlib');

/* ---------- Thrift compact protocol ---------- */
const CT = { STOP: 0, TRUE: 1, FALSE: 2, BYTE: 3, I16: 4, I32: 5, I64: 6, DOUBLE: 7, BINARY: 8, LIST: 9, SET: 10, MAP: 11, STRUCT: 12 };

class TReader {
  constructor(buf, pos = 0) { this.b = buf; this.p = pos; }
  byte() { if (this.p >= this.b.length) throw new Error('Parquet metadata is truncated.'); return this.b[this.p++]; }
  varint() { // unsigned, up to 64 bits; returned as Number when safe, else BigInt
    let lo = 0, shift = 0, b;
    do { b = this.byte(); if (shift < 28) lo |= (b & 0x7f) << shift; else return this._bigTail(lo, shift, b); shift += 7; } while (b & 0x80);
    return lo >>> 0;
  }
  _bigTail(lo, shift, b) {
    let v = BigInt(lo >>> 0) | (BigInt(b & 0x7f) << BigInt(shift)); shift += 7;
    while (b & 0x80) { b = this.byte(); v |= BigInt(b & 0x7f) << BigInt(shift); shift += 7; }
    return v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : v;
  }
  zz() { // zigzag
    const v = this.varint();
    if (typeof v === 'bigint') return (v >> 1n) ^ -(v & 1n);
    return v % 2 === 0 ? v / 2 : -(v + 1) / 2;
  }
  double() { const v = this.b.readDoubleLE(this.p); this.p += 8; return v; }
  binary() { const n = this.varint(); const s = this.b.subarray(this.p, this.p + n); this.p += n; return s; }
  value(t) {
    switch (t) {
      case CT.TRUE: return true; case CT.FALSE: return false;
      case CT.BYTE: { const v = this.byte(); return v > 127 ? v - 256 : v; }
      case CT.I16: case CT.I32: case CT.I64: return this.zz();
      case CT.DOUBLE: return this.double();
      case CT.BINARY: return this.binary();
      case CT.LIST: case CT.SET: {
        const h = this.byte(); let n = h >> 4; const et = h & 15; if (n === 15) n = this.varint();
        const out = new Array(n);
        for (let i = 0; i < n; i++) out[i] = et === CT.TRUE || et === CT.FALSE ? this.byte() === 1 : this.value(et);
        return out;
      }
      case CT.MAP: {
        const n = this.varint(); const m = new Map(); if (!n) return m;
        const kv = this.byte(), kt = kv >> 4, vt = kv & 15;
        for (let i = 0; i < n; i++) { const k = this.value(kt); m.set(k, this.value(vt)); }
        return m;
      }
      case CT.STRUCT: return this.struct();
      default: throw new Error('Unsupported thrift type ' + t + ' in Parquet metadata.');
    }
  }
  struct() { // { fieldId: value }
    const o = {}; let last = 0;
    for (;;) {
      const h = this.byte(); if (h === CT.STOP) return o;
      const t = h & 15, d = h >> 4; const id = d ? last + d : this.zz(); last = id;
      o[id] = this.value(t);
    }
  }
}

class TWriter {
  constructor() { this.parts = []; this.cur = []; this.stack = []; this.last = 0; }
  _b(x) { this.cur.push(x); }
  _flush() { if (this.cur.length) { this.parts.push(Buffer.from(this.cur)); this.cur = []; } }
  varint(v) { // non-negative Number or BigInt
    if (typeof v === 'bigint') { while (v >= 0x80n) { this._b(Number(v & 0x7fn) | 0x80); v >>= 7n; } this._b(Number(v)); return; }
    while (v >= 0x80) { this._b((v % 0x80) | 0x80); v = Math.floor(v / 0x80); } this._b(v);
  }
  zz(v) { if (typeof v === 'bigint') this.varint(v >= 0n ? v << 1n : ((-v) << 1n) - 1n); else this.varint(v >= 0 ? v * 2 : -v * 2 - 1); }
  head(id, t) { const d = id - this.last; if (d > 0 && d <= 15) this._b((d << 4) | t); else { this._b(t); this.zz(id); } this.last = id; }
  i32(id, v) { this.head(id, CT.I32); this.zz(v); }
  i64(id, v) { this.head(id, CT.I64); this.zz(v); }
  bool(id, v) { this.head(id, v ? CT.TRUE : CT.FALSE); }
  str(id, s) { this.head(id, CT.BINARY); const b = Buffer.from(s, 'utf8'); this.varint(b.length); this._flush(); this.parts.push(b); }
  begin(id) { this.head(id, CT.STRUCT); this.stack.push(this.last); this.last = 0; }
  end() { this._b(CT.STOP); this.last = this.stack.pop(); }
  list(id, et, items, writeItem) {
    this.head(id, CT.LIST); const n = items.length;
    if (n < 15) this._b((n << 4) | et); else { this._b(0xf0 | et); this.varint(n); }
    for (const it of items) writeItem(it);
  }
  structItem(fn) { this.stack.push(this.last); this.last = 0; fn(); this._b(CT.STOP); this.last = this.stack.pop(); }
  rawZz(v) { this.zz(v); }
  rawStr(s) { const b = Buffer.from(s, 'utf8'); this.varint(b.length); this._flush(); this.parts.push(b); }
  buffer() { this._flush(); return Buffer.concat(this.parts); }
}

/* ---------- Snappy (decompress only) ---------- */
function snappyDecompress(src) {
  let p = 0, len = 0, shift = 0, b;
  do { b = src[p++]; len |= (b & 0x7f) << shift; shift += 7; } while (b & 0x80);
  const out = Buffer.allocUnsafe(len >>> 0); let o = 0;
  while (p < src.length) {
    const tag = src[p++], kind = tag & 3;
    if (kind === 0) {
      let n = tag >> 2;
      if (n >= 60) { const k = n - 59; n = 0; for (let i = 0; i < k; i++) n |= src[p + i] << (8 * i); n >>>= 0; p += k; }
      n += 1; src.copy(out, o, p, p + n); p += n; o += n; continue;
    }
    let n, off;
    if (kind === 1) { n = 4 + ((tag >> 2) & 7); off = ((tag >> 5) << 8) | src[p++]; }
    else if (kind === 2) { n = (tag >> 2) + 1; off = src[p] | (src[p + 1] << 8); p += 2; }
    else { n = (tag >> 2) + 1; off = (src[p] | (src[p + 1] << 8) | (src[p + 2] << 16) | (src[p + 3] << 24)) >>> 0; p += 4; }
    if (!off || off > o) throw new Error('Corrupt Snappy data in Parquet file.');
    if (off >= n) { out.copy(out, o, o - off, o - off + n); o += n; }
    else for (let i = 0; i < n; i++, o++) out[o] = out[o - off];
  }
  if (o !== out.length) throw new Error('Corrupt Snappy data in Parquet file.');
  return out;
}

const CODEC_NAME = ['UNCOMPRESSED', 'SNAPPY', 'GZIP', 'LZO', 'BROTLI', 'LZ4', 'ZSTD', 'LZ4_RAW'];
function decompress(codec, buf, size) {
  switch (codec) {
    case 0: return buf;
    case 1: return snappyDecompress(buf);
    case 2: return zlib.gunzipSync(buf);
    case 4: return zlib.brotliDecompressSync(buf);
    case 6: if (!zlib.zstdDecompressSync) throw new Error('This Node.js version has no ZSTD support.'); return zlib.zstdDecompressSync(buf);
    default: throw new Error(`Parquet compression ${CODEC_NAME[codec] || codec} isn't supported. Re-save the file with SNAPPY, GZIP or ZSTD.`);
  }
}

/* ---------- Levels and dictionary indices (RLE / bit-packed hybrid) ---------- */
function readHybrid(buf, pos, end, bitWidth, count, out) { // fills out[0..count) ; returns end position
  let i = 0; const bytesW = (bitWidth + 7) >> 3, mask = bitWidth === 32 ? 0xffffffff : (1 << bitWidth) - 1;
  while (i < count && pos < end) {
    let h = 0, shift = 0, b;
    do { b = buf[pos++]; h += (b & 0x7f) * 2 ** shift; shift += 7; } while (b & 0x80);
    if (h % 2 === 1) { // bit-packed: (h >> 1) groups of 8 values
      const n = Math.floor(h / 2) * 8; let acc = 0, bits = 0;
      for (let k = 0; k < n; k++) {
        while (bits < bitWidth) { acc += (buf[pos++] || 0) * 2 ** bits; bits += 8; }
        const v = bitWidth ? acc % 2 ** bitWidth : 0; acc = Math.floor(acc / 2 ** bitWidth); bits -= bitWidth;
        if (i < count) out[i++] = v;
      }
    } else {
      const n = Math.floor(h / 2); let v = 0; for (let k = 0; k < bytesW; k++) v += buf[pos++] * 2 ** (8 * k);
      v = v & mask; const stop = Math.min(count, i + n); while (i < stop) out[i++] = v;
    }
  }
  if (i < count) throw new Error('Corrupt RLE data in Parquet file.');
  return pos;
}
const bitWidthOf = (max) => (max === 0 ? 0 : 32 - Math.clz32(max));

/* ---------- DELTA and BYTE_STREAM_SPLIT encodings (Spark and v2 writers) ---------- */
function uleb(buf, st) { let v = 0n, sh = 0n, b; do { b = buf[st.p++]; v |= BigInt(b & 0x7f) << sh; sh += 7n; } while (b & 0x80); return v; }
const unzz = (v) => (v >> 1n) ^ -(v & 1n);
function deltaBinary(buf, st, signed64) { // -> BigInt[] ; st.p advances past the encoded values
  const block = Number(uleb(buf, st)), minis = Number(uleb(buf, st)), total = Number(uleb(buf, st));
  let prev = unzz(uleb(buf, st)); const out = []; if (total) out.push(prev);
  const per = block / minis;
  while (out.length < total) {
    const minDelta = unzz(uleb(buf, st)), widths = []; for (let i = 0; i < minis; i++) widths.push(buf[st.p++]);
    for (let m = 0; m < minis && out.length < total; m++) {
      const w = widths[m]; let bitPos = st.p * 8;
      for (let i = 0; i < per; i++) {
        let v = 0n; for (let k = 0; k < w; k++, bitPos++) if ((buf[bitPos >> 3] >> (bitPos & 7)) & 1) v |= 1n << BigInt(k);
        if (out.length < total) { prev = signed64 ? BigInt.asIntN(64, prev + minDelta + v) : BigInt.asIntN(32, prev + minDelta + v); out.push(prev); }
      }
      st.p += (per * w) >> 3;
    }
  }
  return out;
}
function deltaLengthBytes(buf, st) { const lens = deltaBinary(buf, st, false); return lens.map(l => { const n = Number(l), v = buf.subarray(st.p, st.p + n); st.p += n; return v; }); }
function deltaBytes(buf, st) {
  const pre = deltaBinary(buf, st, false), suf = deltaLengthBytes(buf, st); let prev = Buffer.alloc(0);
  return suf.map((s, i) => { const v = Buffer.concat([prev.subarray(0, Number(pre[i])), s]); prev = v; return v; });
}
function byteStreamSplit(col, buf, pos, n) {
  const k = col.type === TYPE.FLOAT || col.type === TYPE.INT32 ? 4 : col.type === TYPE.DOUBLE || col.type === TYPE.INT64 ? 8 : col.len;
  const tmp = Buffer.allocUnsafe(n * k); for (let j = 0; j < k; j++) for (let i = 0; i < n; i++) tmp[i * k + j] = buf[pos + j * n + i];
  const out = new Array(n); readPlain(col, tmp, 0, n, out); return out;
}

/* ---------- Schema ---------- */
const TYPE = { BOOLEAN: 0, INT32: 1, INT64: 2, INT96: 3, FLOAT: 4, DOUBLE: 5, BYTE_ARRAY: 6, FIXED: 7 };
const TYPE_NAME = ['BOOLEAN', 'INT32', 'INT64', 'INT96', 'FLOAT', 'DOUBLE', 'BYTE_ARRAY', 'FIXED_LEN_BYTE_ARRAY'];

function describeLeaf(el) { // -> { kind, ... } how to turn a physical value into a cell
  const lt = el[10] || null, ct = el[6], type = el[1];
  if (lt) {
    if (lt[1] || lt[4] || lt[12]) return { kind: 'string' };              // STRING, ENUM, JSON
    if (lt[14]) return { kind: 'uuid' };
    if (lt[5]) return { kind: 'decimal', scale: lt[5][1] || 0 };
    if (lt[6]) return { kind: 'date' };
    if (lt[7]) return { kind: 'time', unit: unitOf(lt[7][2]) };
    if (lt[8]) return { kind: 'timestamp', unit: unitOf(lt[8][2]), utc: !!lt[8][1] };
    if (lt[10]) return { kind: 'int', bits: lt[10][1], signed: lt[10][2] !== false };
    if (lt[13]) return { kind: 'binary' };
  }
  switch (ct) {
    case 0: case 4: case 19: return { kind: 'string' };                   // UTF8, ENUM, JSON
    case 5: return { kind: 'decimal', scale: el[7] || 0 };
    case 6: return { kind: 'date' };
    case 7: return { kind: 'time', unit: 'ms' }; case 8: return { kind: 'time', unit: 'us' };
    case 9: return { kind: 'timestamp', unit: 'ms', utc: true }; case 10: return { kind: 'timestamp', unit: 'us', utc: true };
    case 11: return { kind: 'int', bits: 8, signed: false }; case 12: return { kind: 'int', bits: 16, signed: false };
    case 13: return { kind: 'int', bits: 32, signed: false }; case 14: return { kind: 'int', bits: 64, signed: false };
  }
  if (type === TYPE.INT96) return { kind: 'int96' };
  if (type === TYPE.BYTE_ARRAY) return { kind: 'bytes' };                 // unannotated binary: text if valid UTF-8, else hex
  if (type === TYPE.FIXED) return { kind: 'binary' };
  return { kind: 'plain' };
}
function unitOf(u) { return !u ? 'ms' : u[1] ? 'ms' : u[2] ? 'us' : 'ns'; }

function parseSchema(meta) {
  const els = meta[2] || []; if (!els.length) throw new Error('The Parquet file has no schema.');
  const root = els[0], n = root[5] || 0, cols = []; let i = 1;
  for (let c = 0; c < n; c++) {
    const el = els[i]; if (!el) throw new Error('The Parquet schema is truncated.');
    const name = el[4] ? el[4].toString('utf8') : 'column_' + (c + 1);
    if (el[5]) throw new Error(`Column "${name}" is nested (a struct, list or map). QuantETL reads flat Parquet files; flatten it first, or export it as JSONL.`);
    if (el[3] === 2) throw new Error(`Column "${name}" is a repeated field. QuantETL reads flat Parquet files; flatten it first, or export it as JSONL.`);
    cols.push({ name, type: el[1], len: el[2] || 0, optional: el[3] === 1, leaf: describeLeaf(el) });
    i++;
  }
  return cols;
}

/* ---------- Values ---------- */
const UTF8 = new TextDecoder('utf-8', { fatal: true });
function textOrHex(b) { try { return UTF8.decode(b); } catch { return '0x' + b.toString('hex'); } }
const pad = (n, w = 2) => String(n).padStart(w, '0');
function ymd(days) { const d = new Date(days * 86400000); return `${pad(d.getUTCFullYear(), 4)}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`; }
function timestampText(v, unit, utc) { // v: Number or BigInt in unit since epoch
  const per = unit === 'ms' ? 1000n : unit === 'us' ? 1000000n : 1000000000n, digits = unit === 'ms' ? 3 : unit === 'us' ? 6 : 9;
  const big = BigInt(v); let sec = big / per, frac = big % per; if (frac < 0n) { frac += per; sec -= 1n; }
  const d = new Date(Number(sec) * 1000);
  let s = `${pad(d.getUTCFullYear(), 4)}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
  if (frac) s += '.' + String(frac).padStart(digits, '0');
  return utc ? s + 'Z' : s;
}
function timeText(v, unit) {
  const per = unit === 'ms' ? 1000n : unit === 'us' ? 1000000n : 1000000000n, digits = unit === 'ms' ? 3 : unit === 'us' ? 6 : 9;
  const big = BigInt(v), sec = Number(big / per), frac = big % per;
  let s = `${pad(Math.floor(sec / 3600))}:${pad(Math.floor(sec / 60) % 60)}:${pad(sec % 60)}`;
  if (frac) s += '.' + String(frac).padStart(digits, '0');
  return s;
}
function decimalText(unscaled, scale) { // BigInt -> plain decimal text
  const neg = unscaled < 0n; let s = (neg ? -unscaled : unscaled).toString();
  if (scale > 0) { s = s.padStart(scale + 1, '0'); s = s.slice(0, -scale) + '.' + s.slice(-scale); }
  return (neg ? '-' : '') + s;
}
const bigFromBE = (b) => { if (!b.length) return 0n; let v = 0n; for (const x of b) v = (v << 8n) | BigInt(x); if (b[0] & 0x80) v -= 1n << BigInt(8 * b.length); return v; };
const asNumber = (big) => (big >= -9007199254740991n && big <= 9007199254740991n ? Number(big) : big.toString());
function numericDecimal(text) { // a number when it has at most 15 significant digits (exact as a double), else exact text
  return text.replace(/[-.]/g, '').replace(/^0+/, '').length <= 15 ? Number(text) : text;
}

function convert(col, v) {
  const L = col.leaf;
  switch (L.kind) {
    case 'string': return Buffer.isBuffer(v) ? v.toString('utf8') : String(v);
    case 'bytes': return Buffer.isBuffer(v) ? textOrHex(v) : String(v);
    case 'binary': return Buffer.isBuffer(v) ? v.toString('hex') : String(v);
    case 'uuid': { const h = v.toString('hex'); return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`; }
    case 'date': return ymd(v);
    case 'time': return timeText(v, L.unit);
    case 'timestamp': return timestampText(v, L.unit, L.utc);
    case 'int96': { const nanos = v.readBigInt64LE(0), day = v.readInt32LE(8); return timestampText(BigInt(day - 2440588) * 86400000000000n + nanos, 'ns', true); }
    case 'decimal': { const u = Buffer.isBuffer(v) ? bigFromBE(v) : BigInt(v); return numericDecimal(decimalText(u, L.scale)); }
    case 'int':
      if (!L.signed) { if (col.type === TYPE.INT32) return v >>> 0; return asNumber(BigInt.asUintN(64, BigInt(v))); }
      return typeof v === 'bigint' ? asNumber(v) : v;
    default:
      if (typeof v === 'bigint') return asNumber(v);
      if (Buffer.isBuffer(v)) return v.toString('utf8');
      return v;
  }
}

function readPlain(col, buf, pos, n, out) { // physical values -> out (raw); returns new pos
  switch (col.type) {
    case TYPE.BOOLEAN: for (let i = 0; i < n; i++) out[i] = ((buf[pos + (i >> 3)] >> (i & 7)) & 1) === 1; return pos + ((n + 7) >> 3);
    case TYPE.INT32: for (let i = 0; i < n; i++, pos += 4) out[i] = buf.readInt32LE(pos); return pos;
    case TYPE.INT64: for (let i = 0; i < n; i++, pos += 8) { const lo = buf.readUInt32LE(pos), hi = buf.readInt32LE(pos + 4); out[i] = (hi >= -2097152 && hi < 2097152) ? hi * 4294967296 + lo : buf.readBigInt64LE(pos); } return pos;
    case TYPE.INT96: for (let i = 0; i < n; i++, pos += 12) out[i] = buf.subarray(pos, pos + 12); return pos;
    case TYPE.FLOAT: for (let i = 0; i < n; i++, pos += 4) out[i] = Math.fround(buf.readFloatLE(pos)); return pos;
    case TYPE.DOUBLE: for (let i = 0; i < n; i++, pos += 8) out[i] = buf.readDoubleLE(pos); return pos;
    case TYPE.BYTE_ARRAY: for (let i = 0; i < n; i++) { const l = buf.readUInt32LE(pos); pos += 4; out[i] = buf.subarray(pos, pos + l); pos += l; } return pos;
    case TYPE.FIXED: for (let i = 0; i < n; i++, pos += col.len) out[i] = buf.subarray(pos, pos + col.len); return pos;
  }
  throw new Error('Unknown Parquet type ' + col.type);
}
// A float32 as its shortest decimal that reads back as the same float32 (0.1, not 0.10000000149011612).
const floatCell = (col, v) => { if (col.type !== TYPE.FLOAT || typeof v !== 'number' || !Number.isFinite(v)) return v; for (let d = 1; d <= 9; d++) { const x = +v.toPrecision(d); if (Math.fround(x) === v) return x; } return v; };

/* ---------- Reading ---------- */
async function readRange(fh, start, len) { const b = Buffer.allocUnsafe(len); let got = 0; while (got < len) { const { bytesRead } = await fh.read(b, got, len - got, start + got); if (!bytesRead) throw new Error('The Parquet file is truncated.'); got += bytesRead; } return b; }

async function readMeta(fh, size) {
  if (size < 12) throw new Error('This is not a Parquet file.');
  const tail = await readRange(fh, size - 8, 8);
  if (tail.toString('latin1', 4) !== 'PAR1') throw new Error('This is not a Parquet file (missing PAR1 footer).');
  const len = tail.readUInt32LE(0); if (len > size - 12) throw new Error('The Parquet footer is corrupt.');
  const head = await readRange(fh, 0, 4); if (head.toString('latin1') !== 'PAR1') throw new Error('This is not a Parquet file.');
  if (len > 256 * 1024 * 1024) throw new Error('The Parquet footer is too large.');
  return new TReader(await readRange(fh, size - 8 - len, len)).struct();
}

/** Column names and row count without reading the data. */
async function parquetInfo(file) {
  const fh = await fs.promises.open(file, 'r');
  try { const meta = await readMeta(fh, (await fh.stat()).size); const cols = parseSchema(meta); return { columns: cols.map(c => c.name), rows: Number(meta[3] || 0), rowGroups: (meta[4] || []).length, createdBy: meta[6] ? meta[6].toString() : '' }; }
  finally { await fh.close(); }
}

function decodeColumnChunk(col, cm, buf, numRows) { // -> array of cells, length numRows
  const out = new Array(numRows); let filled = 0, p = 0, dict = null;
  const codec = cm[4], maxDef = col.optional ? 1 : 0;
  const total = Number(cm[5]);
  let seen = 0;
  while (seen < total && p < buf.length) {
    const r = new TReader(buf, p); const ph = r.struct(); p = r.p;
    const type = ph[1], usize = ph[2], csize = ph[3];
    const raw = buf.subarray(p, p + csize); p += csize;
    if (type === 2) { // dictionary page
      const d = decompress(codec, raw, usize), dh = ph[7], n = dh[1];
      const vals = new Array(n); readPlain(col, d, 0, n, vals); dict = vals.map(v => convert(col, v)).map(v => floatCell(col, v)); continue;
    }
    if (type !== 0 && type !== 3) continue; // index pages
    let page, defs = null, n, enc, pos;
    if (type === 0) {
      const h = ph[5]; n = h[1]; enc = h[2];
      page = decompress(codec, raw, usize); pos = 0;
      if (maxDef) { const len = page.readUInt32LE(0); defs = new Uint8Array(n); readHybrid(page, 4, 4 + len, 1, n, defs); pos = 4 + len; }
    } else {
      const h = ph[8]; n = h[1]; enc = h[4]; const dl = h[5] || 0, rl = h[6] || 0, compressed = h[7] !== false;
      if (rl) throw new Error(`Column "${col.name}" has repetition levels; QuantETL reads flat Parquet files.`);
      if (maxDef) { defs = new Uint8Array(n); readHybrid(raw, 0, dl, 1, n, defs); }
      const body = raw.subarray(dl + rl);
      page = compressed ? decompress(codec, body, usize - dl - rl) : body; pos = 0;
    }
    let nn = n; if (defs) { nn = 0; for (let i = 0; i < n; i++) if (defs[i] === maxDef) nn++; }
    let vals;
    if (enc === 3 && col.type === TYPE.BOOLEAN) { // RLE booleans (used in v2 pages): 4-byte length, then bit width 1
      const len = page.readUInt32LE(pos), bits = new Uint8Array(nn); if (nn) readHybrid(page, pos + 4, pos + 4 + len, 1, nn, bits);
      vals = new Array(nn); for (let i = 0; i < nn; i++) vals[i] = bits[i] === 1;
    } else if (enc === 0) { vals = new Array(nn); readPlain(col, page, pos, nn, vals); for (let i = 0; i < nn; i++) vals[i] = floatCell(col, convert(col, vals[i])); }
    else if (enc === 2 || enc === 8) {
      if (!dict) throw new Error(`Column "${col.name}" uses a dictionary page that is missing.`);
      const bw = page[pos]; const idx = new Uint32Array(nn); if (nn) readHybrid(page, pos + 1, page.length, bw, nn, idx);
      vals = new Array(nn); for (let i = 0; i < nn; i++) { const v = dict[idx[i]]; if (v === undefined) throw new Error(`Column "${col.name}" has a dictionary index out of range.`); vals[i] = v; }
    } else if (enc === 5 && (col.type === TYPE.INT32 || col.type === TYPE.INT64)) {
      const st = { p: pos }; const big = nn ? deltaBinary(page, st, col.type === TYPE.INT64) : [];
      vals = big.map(b => floatCell(col, convert(col, col.type === TYPE.INT32 ? Number(b) : (b >= -9007199254740991n && b <= 9007199254740991n ? Number(b) : b))));
    } else if ((enc === 6 || enc === 7) && (col.type === TYPE.BYTE_ARRAY || col.type === TYPE.FIXED)) {
      const st = { p: pos }; vals = (nn ? (enc === 6 ? deltaLengthBytes(page, st) : deltaBytes(page, st)) : []).map(v => convert(col, v));
    } else if (enc === 9) {
      vals = byteStreamSplit(col, page, pos, nn).map(v => floatCell(col, convert(col, v)));
    } else throw new Error(`Column "${col.name}" uses Parquet encoding ${['PLAIN', '', 'PLAIN_DICTIONARY', 'RLE', 'BIT_PACKED', 'DELTA_BINARY_PACKED', 'DELTA_LENGTH_BYTE_ARRAY', 'DELTA_BYTE_ARRAY', 'RLE_DICTIONARY', 'BYTE_STREAM_SPLIT'][enc] || enc}, which isn't supported yet. Re-save it with dictionary or plain encoding.`);
    if (defs) { let k = 0; for (let i = 0; i < n; i++) out[filled++] = defs[i] === maxDef ? vals[k++] : ''; }
    else for (let i = 0; i < n; i++) out[filled++] = vals[i];
    seen += n;
  }
  if (filled !== numRows) throw new Error(`Column "${col.name}" has ${filled} values in a row group of ${numRows} rows.`);
  return out;
}

/**
 * Yields { columns, rows } batches (rows are arrays; nulls are ''). opts: batch (default 50,000), onBytes(bytes).
 */
async function* readParquet(file, opts = {}) {
  const batch = opts.batch || 50000;
  const fh = await fs.promises.open(file, 'r');
  try {
    const size = (await fh.stat()).size, meta = await readMeta(fh, size), cols = parseSchema(meta);
    const columns = dedupe(cols.map(c => c.name)), groups = (meta[4] || []).slice(...(opts.groups || [0]));
    let any = false;
    for (const g of groups) {
      const numRows = Number(g[3]), chunks = g[1] || [];
      if (!numRows) continue;
      const data = [];
      let maxEnd = 0;
      for (let c = 0; c < cols.length; c++) {
        const cm = chunks[c] && chunks[c][3]; if (!cm) throw new Error(`Row group is missing column "${cols[c].name}".`);
        if (chunks[c][1] && chunks[c][1].length) throw new Error('Parquet files that point to other files are not supported.');
        const dictOff = cm[11] ? Number(cm[11]) : 0, dataOff = Number(cm[9]);
        const start = dictOff > 0 && dictOff < dataOff ? dictOff : dataOff, len = Number(cm[7]);
        const buf = await readRange(fh, start, len); maxEnd = Math.max(maxEnd, start + len);
        data.push(decodeColumnChunk(cols[c], cm, buf, numRows));
      }
      if (opts.onBytes) opts.onBytes(Math.min(size, maxEnd));
      for (let s = 0; s < numRows; s += batch) {
        const e = Math.min(numRows, s + batch), rows = new Array(e - s);
        for (let i = s; i < e; i++) { const r = new Array(cols.length); for (let c = 0; c < cols.length; c++) r[c] = data[c][i]; rows[i - s] = r; }
        any = true; yield { columns, rows };
      }
    }
    if (!any) yield { columns, rows: [] };
    if (opts.onBytes) opts.onBytes(size);
  } finally { await fh.close(); }
}
function dedupe(names) { const seen = {}; return names.map((h, i) => { h = String(h).trim() || 'column_' + (i + 1); if (seen[h]) { seen[h]++; return h + '_' + seen[h]; } seen[h] = 1; return h; }); }

/* ---------- Writing ---------- */
const QETL = require('./qetl');
const isNullCell = (v) => v === null || v === undefined || v === '';
const TS_RE = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,6}))?)?(Z|[+-]\d{2}:?\d{2})?$/;

function encodeValue(type, v) {
  switch (type) {
    case 'boolean': return v === true || v === 'true';
    case 'int64': return BigInt(typeof v === 'number' ? v : String(v));
    case 'double': return typeof v === 'number' ? v : +v;
    case 'date': return Math.round(Date.parse(String(v) + 'T00:00:00Z') / 86400000);
    case 'timestamp': case 'timestamp_utc': return tsMicros(String(v));
    default: return Buffer.from(typeof v === 'string' ? v : String(v), 'utf8');
  }
}
function tsMicros(s) {
  const m = TS_RE.exec(s); let ms = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0));
  if (m[8] && m[8] !== 'Z') { const z = m[8].replace(':', ''), sign = z[0] === '-' ? -1 : 1; ms -= sign * (+z.slice(1, 3) * 60 + +z.slice(3, 5)) * 60000; }
  const frac = (m[7] || '').padEnd(6, '0');
  return BigInt(ms) * 1000n + BigInt(+frac);
}
const PHYS = { boolean: TYPE.BOOLEAN, int64: TYPE.INT64, double: TYPE.DOUBLE, date: TYPE.INT32, timestamp: TYPE.INT64, timestamp_utc: TYPE.INT64, string: TYPE.BYTE_ARRAY };

function plainValues(type, vals) {
  const n = vals.length;
  switch (type) {
    case 'boolean': { const b = Buffer.alloc((n + 7) >> 3); vals.forEach((v, i) => { if (v) b[i >> 3] |= 1 << (i & 7); }); return b; }
    case 'int64': case 'timestamp': case 'timestamp_utc': { const b = Buffer.allocUnsafe(8 * n); vals.forEach((v, i) => b.writeBigInt64LE(v, 8 * i)); return b; }
    case 'double': { const b = Buffer.allocUnsafe(8 * n); vals.forEach((v, i) => b.writeDoubleLE(v, 8 * i)); return b; }
    case 'date': { const b = Buffer.allocUnsafe(4 * n); vals.forEach((v, i) => b.writeInt32LE(v, 4 * i)); return b; }
    default: { let len = 0; for (const v of vals) len += 4 + v.length; const b = Buffer.allocUnsafe(len); let p = 0; for (const v of vals) { b.writeUInt32LE(v.length, p); p += 4; v.copy(b, p); p += v.length; } return b; }
  }
}
function rleBits(defs) { // RLE runs of 0/1 levels, bit width 1
  const out = []; let i = 0;
  const varint = (v) => { while (v >= 0x80) { out.push((v % 0x80) | 0x80); v = Math.floor(v / 0x80); } out.push(v); };
  while (i < defs.length) { let j = i; while (j < defs.length && defs[j] === defs[i]) j++; varint((j - i) * 2); out.push(defs[i]); i = j; }
  return Buffer.from(out);
}

const CODEC = zlib.zstdCompressSync ? 6 : 2;
const compress = (b) => (CODEC === 6 ? zlib.zstdCompressSync(b, { params: { [zlib.constants.ZSTD_c_compressionLevel]: 3 } }) : zlib.gzipSync(b));

class ParquetWriter {
  /** columns: names; types: one of boolean|int64|double|date|timestamp|timestamp_utc|string per column. */
  constructor(file, columns, types, opts = {}) {
    this.file = file; this.columns = columns; this.types = types; this.rowGroupSize = opts.rowGroupSize || 100000;
    this.fd = fs.openSync(file, 'w'); this.pos = 0; this.groups = []; this.pending = []; this.total = 0;
    this._write(Buffer.from('PAR1'));
  }
  _write(b) { fs.writeSync(this.fd, b, 0, b.length, this.pos); this.pos += b.length; }
  add(rows) { for (const r of rows) { this.pending.push(r); if (this.pending.length >= this.rowGroupSize) this._flushGroup(); } }
  _flushGroup() {
    const rows = this.pending; if (!rows.length) return; this.pending = [];
    const cols = []; let groupBytes = 0;
    for (let c = 0; c < this.columns.length; c++) {
      const type = this.types[c], defs = new Uint8Array(rows.length), vals = [];
      for (let i = 0; i < rows.length; i++) { const v = rows[i][c]; if (isNullCell(v)) continue; defs[i] = 1; vals.push(encodeValue(type, v)); }
      const lv = rleBits(defs), lenB = Buffer.alloc(4); lenB.writeUInt32LE(lv.length);
      const body = Buffer.concat([lenB, lv, plainValues(type, vals)]), comp = compress(body);
      const h = new TWriter();
      h.i32(1, 0); h.i32(2, body.length); h.i32(3, comp.length);
      h.begin(5); h.i32(1, rows.length); h.i32(2, 0); h.i32(3, 3); h.i32(4, 3); h.end();
      h._b(CT.STOP); const head = h.buffer();
      const off = this.pos; this._write(head); this._write(comp);
      const size = head.length + comp.length; groupBytes += head.length + body.length;
      cols.push({ off, size, usize: head.length + body.length, n: rows.length });
    }
    this.groups.push({ cols, rows: rows.length, bytes: groupBytes }); this.total += rows.length;
  }
  close() {
    this._flushGroup();
    const w = new TWriter();
    w.i32(1, 1);
    const schema = [{ root: true }, ...this.columns.map((name, c) => ({ name, type: this.types[c] }))];
    w.list(2, CT.STRUCT, schema, (el) => w.structItem(() => {
      if (el.root) { w.str(4, 'schema'); w.i32(5, this.columns.length); return; }
      w.i32(1, PHYS[el.type]); w.i32(3, 1); w.str(4, el.name);
      if (el.type === 'string') w.i32(6, 0); else if (el.type === 'date') w.i32(6, 6); else if (el.type === 'timestamp_utc') w.i32(6, 10);
      if (el.type === 'string') { w.begin(10); w.begin(1); w.end(); w.end(); }
      else if (el.type === 'date') { w.begin(10); w.begin(6); w.end(); w.end(); }
      else if (el.type === 'timestamp' || el.type === 'timestamp_utc') { w.begin(10); w.begin(8); w.bool(1, el.type === 'timestamp_utc'); w.begin(2); w.begin(2); w.end(); w.end(); w.end(); w.end(); }
    }));
    w.i64(3, this.total);
    w.list(4, CT.STRUCT, this.groups, (g) => w.structItem(() => {
      w.list(1, CT.STRUCT, g.cols, (cc) => {
        const c = g.cols.indexOf(cc);
        w.structItem(() => {
          w.i64(2, cc.off);
          w.begin(3);
          w.i32(1, PHYS[this.types[c]]);
          w.list(2, CT.I32, [0, 3], (e) => w.rawZz(e));
          w.list(3, CT.BINARY, [this.columns[c]], (s) => w.rawStr(s));
          w.i32(4, CODEC); w.i64(5, cc.n); w.i64(6, cc.usize); w.i64(7, cc.size); w.i64(9, cc.off);
          w.end();
        });
      });
      w.i64(2, g.bytes); w.i64(3, g.rows);
    }));
    w.str(6, 'QuantETL');
    w._b(CT.STOP);
    const meta = w.buffer(), len = Buffer.alloc(4); len.writeUInt32LE(meta.length);
    this._write(meta); this._write(len); this._write(Buffer.from('PAR1'));
    fs.closeSync(this.fd);
    return { rows: this.total, bytes: this.pos };
  }
}

/** Decide Parquet column types from rows (one pass over the values). */
function decideTypes(columns, rowsIter) {
  const g = columns.map(() => new QETL.TypeGuess());
  for (const rows of rowsIter) for (const r of rows) for (let c = 0; c < g.length; c++) g[c].add(r[c]);
  return g.map(x => x.type());
}

/** Writes a whole in-memory table to a Parquet file. */
function writeTable(file, table, opts = {}) {
  const types = decideTypes(table.columns, [table.rows]);
  const w = new ParquetWriter(file, table.columns, types, opts); w.add(table.rows); return { ...w.close(), types };
}

module.exports = { readParquet, parquetInfo, ParquetWriter, decideTypes, writeTable, snappyDecompress, isParquet: (name) => /\.parquet$/i.test(name || '') };
