#!/usr/bin/env node
// Verifies a QuantETL provenance manifest offline: the Ed25519 signature, and optionally that files match its hashes.
//
//   node scripts/verify-manifest.js manifest.json [--key provenance.pub] [--output data_clean.csv] [--source data.csv]
//
// --key pins the expected public key (from the QuantETL server's data/keys/provenance.pub, or GET
// /api/provenance/pubkey). Without it, the key embedded in the manifest is used, which proves the manifest wasn't
// changed but not who signed it: compare the key ID it prints with the one your organisation publishes.
'use strict';
const fs = require('fs');
const path = require('path');
const P = require(path.join(__dirname, '..', 'lib', 'provenance.js'));

(async () => {
  const args = process.argv.slice(2), opt = (k) => { const i = args.indexOf(k); return i >= 0 ? args.splice(i, 2)[1] : null; };
  const keyFile = opt('--key'), outFile = opt('--output'), srcFile = opt('--source'), file = args[0];
  if (!file) { console.error('Usage: node scripts/verify-manifest.js manifest.json [--key provenance.pub] [--output file] [--source file]'); process.exit(2); }
  let m; try { m = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { console.error('Cannot read the manifest: ' + e.message); process.exit(2); }
  let bad = 0;
  const v = P.verify(m, keyFile ? fs.readFileSync(keyFile, 'utf8') : null);
  console.log(`${v.ok ? 'OK  ' : 'FAIL'} signature${v.keyId ? ` (key ID ${v.keyId}${keyFile ? ', pinned' : ', embedded key: compare it with your published key ID'})` : ''}${v.ok ? '' : ': ' + v.reason}`);
  if (!v.ok) bad++;
  for (const [label, f, part] of [['output', outFile, m.output], ['source', srcFile, m.source]]) {
    if (!f) continue;
    if (!part || !part.sha256) { console.log(`FAIL ${label}: the manifest has no ${label} hash`); bad++; continue; }
    const h = await P.sha256File(f), ok = h === part.sha256;
    console.log(`${ok ? 'OK  ' : 'FAIL'} ${label} file ${path.basename(f)} ${ok ? 'matches' : `does not match (file ${h.slice(0, 16)}…, manifest ${part.sha256.slice(0, 16)}…)`}${part.hash_of ? ` · hash of ${part.hash_of}` : ''}`);
    if (!ok) bad++;
  }
  if (v.ok) {
    console.log(`\n${m.dataset ? m.dataset.name : 'dataset'}: ${m.source ? Number(m.source.rows).toLocaleString('en-US') : '?'} rows in, ${m.output ? Number(m.output.rows).toLocaleString('en-US') : '?'} rows out, ${(m.steps || []).length} steps, signed ${m.created || ''}`);
    (m.steps || []).forEach((s, i) => console.log(`  ${i + 1}. ${s.describe || s.op}`));
  }
  process.exit(bad ? 1 : 0);
})();
