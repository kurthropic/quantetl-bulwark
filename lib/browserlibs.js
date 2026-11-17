// Loads the console's privacy scan (js/guard.js), table comparison (js/diff.js) and AI-data helpers (js/aidata.js)
// into Node, so the server and the qetl terminal app give exactly the same answers as the console.
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const QETL = require('./qetl');

const src = (f) => fs.readFileSync(path.join(__dirname, '..', 'js', f), 'utf8');
if (!globalThis.QDiff) vm.runInThisContext(src('diff.js'), { filename: 'diff.js' });
if (!globalThis.QAI) vm.runInThisContext(src('aidata.js'), { filename: 'aidata.js' });
// guard.js reads window.QETL and sets window.QGuard: give it a window of its own, so Node's global stays untouched.
const box = { console, crypto: globalThis.crypto, QETL };
box.window = box; vm.createContext(box);
vm.runInContext(src('guard.js'), box, { filename: 'guard.js' });

module.exports = { QETL, QGuard: box.QGuard, QDiff: globalThis.QDiff, QAI: globalThis.QAI };
