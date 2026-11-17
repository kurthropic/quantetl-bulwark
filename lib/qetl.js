// Loads the browser engine (js/etl.js) into this Node process once, so server code runs exactly the same steps,
// parsers and type rules as the console.
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

if (!globalThis.QETL) vm.runInThisContext(fs.readFileSync(path.join(__dirname, '..', 'js', 'etl.js'), 'utf8'), { filename: 'etl.js' });
module.exports = globalThis.QETL;
