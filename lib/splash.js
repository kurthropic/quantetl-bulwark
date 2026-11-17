// Bulwark's startup animation: the logo (assets/bulwark-logo.txt) slides in from the right like a marquee, holds,
// then dissolves while "QuantETL BULWARK" and the version type out in its place. It plays on the alternate screen,
// so the terminal is left exactly as it was. Any key skips it. It never plays when input or output isn't a terminal,
// on TERM=dumb, with BULWARK_NO_SPLASH=1, or in a window too small to draw it.
'use strict';
const fs = require('fs');
const path = require('path');

const ART = path.join(__dirname, '..', 'assets', 'bulwark-logo.txt');
const TEAL = /truecolor|24bit/i.test(process.env.COLORTERM || '') ? '38;2;3;153;181' : '38;5;31'; // the logo's #0399b5
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// The art as a grid of filled cells. Lines are made the same width; a line that ends in a run of @ is
// trimmed or extended to that width, so small copy errors at the right edge don't show.
function loadArt() {
  const lines = fs.readFileSync(ART, 'utf8').split('\n').map(l => l.replace(/\s+$/, '')).filter(Boolean);
  const count = {}; for (const l of lines) count[l.length] = (count[l.length] || 0) + 1;
  const W = +Object.entries(count).sort((a, b) => b[1] - a[1])[0][0];
  return { W, H: lines.length, rows: lines.map(l => { const s = l.length > W ? l.slice(0, W) : l + (l.endsWith('@') ? '@' : ' ').repeat(W - l.length); return [...s].map(c => c === '@'); }) };
}

// Scales the art to `cw` columns. Each output character shows two vertical half-cells (▀ ▄ █), so the shape keeps
// twice the vertical detail. Returns rows of characters.
function render(art, cw) {
  const s = art.W / cw, outRows = Math.max(1, Math.round(art.H / s)), grid = [];
  const at = (c, r) => r < art.H && c < art.W && art.rows[r][c];
  const filled = (x, half) => { // coverage of the region under one half-cell, from a 3×3 grid of samples
    let n = 0; for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) if (at(Math.floor((x + (i + 0.5) / 3) * s), Math.floor((half + (j + 0.5) / 3) * s / 2))) n++;
    return n >= 5;
  };
  for (let y = 0; y < outRows; y++) {
    const row = [];
    for (let x = 0; x < cw; x++) { const t = filled(x, 2 * y), b = filled(x, 2 * y + 1); row.push(t && b ? '█' : t ? '▀' : b ? '▄' : ' '); }
    grid.push(row);
  }
  return grid;
}

/** Plays the animation; resolves when it ends or is skipped. Returns false if it didn't play. */
async function play(opts = {}) {
  const out = process.stdout, inp = process.stdin;
  if (!out.isTTY || !inp.isTTY || process.env.TERM === 'dumb' || process.env.BULWARK_NO_SPLASH === '1' || process.env.NO_COLOR) return false;
  const cols = out.columns || 80, rows = out.rows || 24;
  if (cols < 40 || rows < 12) return false;
  let art; try { art = loadArt(); } catch { return false; }
  let cw = Math.min(art.W, cols - 4); if (art.H / (art.W / cw) > rows - 6) cw = Math.floor(art.W * (rows - 6) / art.H);
  const grid = render(art, cw), gh = grid.length, top = Math.max(0, Math.floor((rows - gh) / 2) - 1), left = Math.floor((cols - cw) / 2);
  const title = 'QuantETL  B U L W A R K', sub = opts.version || '';

  let skip = false; const onKey = () => { skip = true; };
  const restore = () => { out.write('\x1b[0m\x1b[?25h\x1b[?1049l'); };
  const onExit = () => restore();
  process.once('exit', onExit);
  try { inp.setRawMode(true); } catch {}
  inp.on('data', onKey); inp.resume();
  out.write('\x1b[?1049h\x1b[?25l\x1b[2J');

  // One frame: the grid at column offset `x` (may start off-screen right), optional typed text in the middle.
  const frame = (x, cells, text) => {
    let s = '\x1b[H';
    for (let r = 0; r < rows - 1; r++) {
      const gy = r - top; let line = '';
      if (gy >= 0 && gy < gh) {
        const g = cells[gy]; let txt = '';
        for (let c = 0; c < cols; c++) { const gx = c - x; txt += gx >= 0 && gx < cw ? g[gx] : ' '; }
        line = `\x1b[${TEAL}m${txt}\x1b[0m`;
      } else line = ' '.repeat(cols);
      if (text) for (const [ty, t, style] of text) if (r === ty && t) line = renderTextLine(cells, gy, gh, cols, x, cw, Math.max(1, Math.floor((cols - t.length) / 2)), t, style);
      s += line + '\r\n';
    }
    out.write(s);
  };
  const renderTextLine = (cells, gy, gh2, c, x, w, tx, t, style) => {
    let pre = '', post = '';
    for (let k = 0; k < c; k++) { const gx = k - x, ch = gy >= 0 && gy < gh2 && gx >= 0 && gx < w ? cells[gy][gx] : ' '; if (k < tx - 1) pre += ch; else if (k > tx + t.length) post += ch; }
    return `\x1b[${TEAL}m${pre}\x1b[0m ${style}${t}\x1b[0m \x1b[${TEAL}m${post}\x1b[0m`;
  };

  try {
    // 1. marquee: slide in from the right, easing to the centre
    const N = 32;
    for (let i = 0; i <= N && !skip; i++) { const p = 1 - Math.pow(1 - i / N, 3); frame(Math.round(cols + (left - cols) * p), grid); await sleep(30); }
    if (!skip) { frame(left, grid); await sleep(450); }
    // 2. dissolve the logo cell by cell while the name types in where it was
    const cells = grid.map(r => [...r]), order = [];
    for (let y = 0; y < gh; y++) for (let x = 0; x < cw; x++) if (cells[y][x] !== ' ') order.push([y, x]);
    for (let i = order.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [order[i], order[j]] = [order[j], order[i]]; }
    const D = 26, mid = top + Math.floor(gh / 2) - 1;
    for (let f = 1; f <= D && !skip; f++) {
      const upto = Math.floor(order.length * f / D);
      for (let k = Math.floor(order.length * (f - 1) / D); k < upto; k++) { const [y, x] = order[k]; cells[y][x] = ' '; }
      const typed = title.slice(0, Math.ceil(title.length * Math.min(1, f / (D * 0.7)))), sv = f > D * 0.55 ? sub.slice(0, Math.ceil(sub.length * Math.min(1, (f - D * 0.55) / (D * 0.35)))) : '';
      frame(left, cells, [[mid, typed, '\x1b[1;97m'], [mid + 2, sv, `\x1b[${TEAL}m`]]);
      await sleep(32);
    }
    if (!skip) { frame(left, cells, [[mid, title, '\x1b[1;97m'], [mid + 2, sub, `\x1b[${TEAL}m`]]); await sleep(700); }
  } finally {
    inp.removeListener('data', onKey);
    try { inp.setRawMode(false); } catch {}
    inp.pause();
    // Keys pressed during the animation were only for skipping it: drop them, and hand stdin back untouched.
    while (inp.read() !== null) {}
    restore(); process.removeListener('exit', onExit);
  }
  return true;
}

/** The logo scaled to a width, as plain lines (no colour), for previews and tests. */
function preview(width) { const art = loadArt(); return render(art, Math.min(art.W, width)).map(r => r.join('')); }

module.exports = { play, preview, loadArt };
