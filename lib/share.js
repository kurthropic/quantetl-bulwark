// Share packages: everything a research centre needs to accept a dataset, in one signed .tar.gz.
//
// Before anything is packed, gate checks must pass: a license is chosen, the contributor attests they have the right
// to share it, no unprotected personal data is left (direct identifiers or personal data inside text), and rows can't
// be singled out from quasi-identifiers (k-anonymity of at least 5). The bundle holds the data (JSONL, Parquet or
// CSV), a dataset card, the license, the attestation, the privacy report, the gate results, the removal ledger when
// there is one, and manifest.json: SHA-256 of every file plus the steps, signed with Ed25519.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { QETL, QGuard } = require('./browserlibs');
const Provenance = require('./provenance');
const Parquet = require('./parquet');

const LICENSES = ['cc-by-4.0', 'cc-by-sa-4.0', 'cc-by-nc-4.0', 'cc0-1.0', 'odc-by', 'odbl', 'apache-2.0', 'mit', 'research-only', 'other'];
const MIN_K = 5;

/**
 * Gate checks. table: the data that would be shared (or a sample of it); prof: its profile.
 * opts: { license, attest: { name, org, rights: true }, allowSensitive, sampled, leaks: { contaminated, evalRows, name } }
 * Returns { ok, checks: [{ id, label, status: 'pass'|'fail'|'warn', detail, fix }], privacy }.
 */
function shareChecks(table, prof, opts = {}) {
  const checks = [], add = (id, label, status, detail, fix) => checks.push({ id, label, status, detail, ...(fix ? { fix } : {}) });
  const lic = String(opts.license || '').trim().toLowerCase();
  add('license', 'License chosen', lic ? 'pass' : 'fail', lic ? `${lic}${LICENSES.includes(lic) ? '' : ' (custom)'}` : 'No license. Researchers can only use data under a license they can read.', lic ? null : `Choose one, e.g. ${LICENSES.slice(0, 4).join(', ')} or research-only.`);
  const a = opts.attest || {};
  const who = [a.name, a.org].filter(Boolean).join(', ');
  add('rights', 'Right to share confirmed', a.rights && who ? 'pass' : 'fail', a.rights && who ? `Confirmed by ${who}` : 'The contributor must confirm, by name, that they have the right to share this data and that any personal data in it was collected with consent or another legal basis.', a.rights && who ? null : 'Confirm the attestation and give your name and organisation.');
  add('rows', 'Has data', table.rows.length ? 'pass' : 'fail', `${table.rows.length.toLocaleString('en-US')} rows × ${table.columns.length} columns${opts.sampled ? ' examined (a sample of a larger file)' : ''}`);
  const privacy = QGuard.scanPrivacy(table, prof);
  const direct = privacy.findings.filter(f => f.category === 'direct' || f.category === 'embedded');
  add('pii', 'No personal data left', direct.length ? 'fail' : 'pass', direct.length ? `Unprotected personal data in ${direct.map(f => `${f.column} (${f.label || f.kind})`).join(', ')}.` : privacy.protected.length ? `Protected columns: ${privacy.protected.join(', ')}.` : 'No names, contact details, ID numbers or account numbers found, in columns or inside text.', direct.length ? 'Add "Protect personal data" or "Redact personal data in text" steps for those columns, or drop them.' : null);
  const sens = privacy.findings.filter(f => f.category === 'sensitive');
  if (sens.length) add('sensitive', 'Sensitive categories', opts.allowSensitive ? 'warn' : 'fail', `Special-category data in ${sens.map(f => f.column).join(', ')} (for example health). ${opts.allowSensitive ? 'Kept on purpose by the contributor.' : ''}`, opts.allowSensitive ? null : 'Remove or generalise it, or confirm it is needed and lawfully shared (allow sensitive).');
  const r = privacy.reid;
  add('reid', `No one can be singled out (k ≥ ${MIN_K})`, !r || r.k >= MIN_K ? 'pass' : 'fail', !r ? 'No quasi-identifiers (birth date, ZIP code, age, gender, location) found.' : `Smallest group sharing ${r.columns.join(' + ')}: k = ${r.k}; ${(r.uniquePct * 100).toFixed(1)}% of rows are unique.`, !r || r.k >= MIN_K ? null : 'Generalise one of those columns (year instead of date, 3-digit ZIP) until every combination is shared by 5 or more rows.');
  if (opts.leaks) add('leaks', 'No overlap with evaluation data', opts.leaks.contaminated ? 'warn' : 'pass', opts.leaks.contaminated ? `${opts.leaks.contaminated} of ${opts.leaks.evalRows} rows of ${opts.leaks.name} also appear in this data. Say so in the card, or remove them.` : `Checked against ${opts.leaks.name}: no overlap.`);
  return { ok: !checks.some(c => c.status === 'fail'), checks, privacy };
}

function privacySummary(p) {
  return { risk: p.risk, level: p.level, counts: p.counts, rows_scanned: p.rowsScanned, sampled: p.sampled, regulations: p.regs,
    protected_columns: p.protected, findings: p.findings.map(f => ({ column: f.column, category: f.category, kind: f.kind, label: f.label, confidence: f.confidence })),
    reidentification: p.reid ? { columns: p.reid.columns, k: p.reid.k, unique_pct: +p.reid.uniquePct.toFixed(4) } : null };
}

/* ---------- tar.gz writer (ustar), streaming ---------- */
function tarHeader(name, size, mtime) {
  const h = Buffer.alloc(512), put = (s, off, len) => h.write(s, off, len, 'utf8'), oct = (n, len) => n.toString(8).padStart(len - 1, '0') + '\0';
  if (Buffer.byteLength(name) > 100) throw new Error('File name too long for the bundle: ' + name);
  put(name, 0, 100); put('0000644\0', 100, 8); put('0000000\0', 108, 8); put('0000000\0', 116, 8);
  put(oct(size, 12), 124, 12); put(oct(Math.floor(mtime / 1000), 12), 136, 12); put('        ', 148, 8); put('0', 156, 1);
  put('ustar\0', 257, 6); put('00', 263, 2); put('quantetl', 265, 32); put('quantetl', 297, 32);
  let sum = 0; for (const b of h) sum += b; put(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8);
  return h;
}
async function writeTarGz(outPath, entries) { // entries: [{ name, file } | { name, data: Buffer }]
  const gz = zlib.createGzip({ level: 6 }), out = fs.createWriteStream(outPath), done = new Promise((res, rej) => { out.on('finish', res); out.on('error', rej); gz.on('error', rej); });
  gz.pipe(out);
  const w = (b) => (gz.write(b) ? null : new Promise(r => gz.once('drain', r)));
  const now = Date.now();
  for (const e of entries) {
    const size = e.file ? fs.statSync(e.file).size : e.data.length;
    await w(tarHeader(e.name, size, now));
    if (e.file) { for await (const c of fs.createReadStream(e.file, { highWaterMark: 1 << 20 })) await w(c); } else await w(e.data);
    const pad = (512 - (size % 512)) % 512; if (pad) await w(Buffer.alloc(pad));
  }
  await w(Buffer.alloc(1024)); gz.end(); await done;
}
const sha256Buf = (b) => crypto.createHash('sha256').update(b).digest('hex');

/**
 * Builds the bundle. o: {
 *   name (dataset name), base (folder name inside the archive), format: 'jsonl'|'parquet'|'csv',
 *   data: { table } or { file (CSV/JSONL/Parquet on disk), delimiter } — the data to share, already cleaned,
 *   card (README.md text), ledgerCSV or ledgerFile (optional), license, attest, gate (shareChecks result),
 *   source: { name, rows, sha256?, hash_of? }, steps, keys (Provenance keys), engine, signer: { user?, tool }
 * }
 * Returns { path, manifest, files }.
 */
async function buildBundle(o, outPath, onProgress) {
  if (!o.gate || !o.gate.ok) throw new Error('The share checks have not passed.');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qetl-share-')), base = (o.base || String(o.name || 'dataset').replace(/\.\w+(\.gz)?$/, '') + '_share').replace(/[^\w.\-]+/g, '_');
  try {
    const fmt = o.format || 'jsonl', dataName = `data.${fmt}`, dataPath = path.join(tmp, dataName);
    if (o.data.table) {
      if (fmt === 'parquet') Parquet.writeTable(dataPath, o.data.table);
      else fs.writeFileSync(dataPath, fmt === 'csv' ? QETL.toCSV(o.data.table) + '\n' : QETL.toJSONL(o.data.table));
    } else {
      const E = require('./bigengine');
      if (fmt === 'csv' && /\.csv$/i.test(o.data.file)) fs.copyFileSync(o.data.file, dataPath);
      else await E.convertFile(o.data.file, fmt === 'csv' ? 'jsonl' : fmt, dataPath, { delimiter: o.data.delimiter, onProgress });
      if (fmt === 'csv' && !/\.csv$/i.test(o.data.file)) throw new Error('CSV bundles of large files need a CSV source.');
    }
    const at = new Date().toISOString(), a = o.attest || {};
    const texts = {
      'README.md': o.card,
      'LICENSE.txt': `License: ${o.license}\n\nChosen by the contributor (${[a.name, a.org].filter(Boolean).join(', ')}) on ${at.slice(0, 10)}.\n${o.license === 'research-only' ? '\nUse is limited to non-commercial research. Redistribution requires the contributor\'s written permission.\n' : '\nSee https://spdx.org/licenses/ or https://opendatacommons.org/licenses/ for the full text of standard licenses.\n'}`,
      'ATTESTATION.md': `# Contributor attestation\n\n- **Contributor:** ${a.name || ''}${a.org ? `, ${a.org}` : ''}\n- **Date:** ${at}\n- **Dataset:** ${o.name}\n\nThe contributor confirmed that:\n\n1. they have the right to share this data under the license in LICENSE.txt;\n2. any personal data it came from was collected with consent or another legal basis, and has been removed or protected as the privacy report shows;\n3. it does not knowingly include material they don't have the rights to (for example copyrighted text without permission).\n${a.note ? `\nNote from the contributor: ${a.note}\n` : ''}\nThis statement is covered by the signature in manifest.json.\n`,
      'privacy_report.json': JSON.stringify(privacySummary(o.gate.privacy), null, 2) + '\n',
      'checks.json': JSON.stringify(o.gate.checks, null, 2) + '\n',
    };
    for (const [n, t] of Object.entries(texts)) fs.writeFileSync(path.join(tmp, n), t);
    if (o.ledgerCSV) fs.writeFileSync(path.join(tmp, 'removal_ledger.csv'), o.ledgerCSV);
    else if (o.ledgerFile && fs.existsSync(o.ledgerFile)) fs.copyFileSync(o.ledgerFile, path.join(tmp, 'removal_ledger.csv'));
    const names = [dataName, 'README.md', 'LICENSE.txt', 'ATTESTATION.md', 'privacy_report.json', 'checks.json', ...(fs.existsSync(path.join(tmp, 'removal_ledger.csv')) ? ['removal_ledger.csv'] : [])];
    const files = [];
    for (const n of names) files.push({ name: n, bytes: fs.statSync(path.join(tmp, n)).size, sha256: await Provenance.sha256File(path.join(tmp, n)) });
    const manifest = Provenance.sign({
      quantetl_manifest: 1, kind: 'share-package',
      dataset: { name: o.name, title: o.title || o.name },
      source: o.source || { name: o.name },
      steps: (o.steps || []).filter(s => !s.disabled && QETL.OPS[s.op]).map(s => ({ op: s.op, params: s.params || {}, describe: QETL.OPS[s.op].describe(s.params || {}) })),
      output: { name: dataName, format: fmt, rows: o.rows, columns: o.columns, sha256: files[0].sha256, hash_of: `the file ${dataName} in this package` },
      files, license: o.license, attestation: { name: a.name || '', org: a.org || '', rights: !!a.rights, at },
      checks: o.gate.checks.map(c => ({ id: c.id, status: c.status })),
      engine: o.engine, created: at, signed_by: { ...(o.signer || {}), key_id: o.keys.keyId },
      ...(o.marking ? { marking: o.marking } : {}),
      ...(o.twoPerson ? { release: { two_person: true, status: 'pending second approval' } } : {}),
    }, o.keys);
    fs.writeFileSync(path.join(tmp, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
    await writeTarGz(outPath, [...names, 'manifest.json'].map(n => ({ name: `${base}/${n}`, file: path.join(tmp, n) })));
    return { path: outPath, manifest, files: [...files, { name: 'manifest.json', bytes: fs.statSync(path.join(tmp, 'manifest.json')).size }] };
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}

/** Reads a bundle back: the manifest and each file's hash, to confirm nothing changed (used by `qetl verify`). */
async function readBundle(file) {
  const raw = zlib.gunzipSync(fs.readFileSync(file)), out = new Map();
  for (let p = 0; p + 512 <= raw.length;) {
    const h = raw.subarray(p, p + 512); if (h.every(b => b === 0)) break;
    const name = h.toString('utf8', 0, 100).replace(/\0.*$/s, ''), size = parseInt(h.toString('ascii', 124, 136).replace(/\0.*$/s, '').trim() || '0', 8);
    out.set(name.split('/').slice(1).join('/'), raw.subarray(p + 512, p + 512 + size));
    p += 512 + Math.ceil(size / 512) * 512;
  }
  const m = out.get('manifest.json'); if (!m) throw new Error('No manifest.json in this bundle.');
  const manifest = JSON.parse(m.toString('utf8'));
  const files = (manifest.files || []).map(f => { const b = out.get(f.name); return { ...f, present: !!b, ok: !!b && sha256Buf(b) === f.sha256 }; });
  const ap = out.get('approval.json');
  return { manifest, manifestSha256: sha256Buf(m), approval: ap ? JSON.parse(ap.toString('utf8')) : null, files, entries: out,
    extra: [...out.keys()].filter(n => n !== 'manifest.json' && n !== 'approval.json' && !(manifest.files || []).some(f => f.name === n)) };
}

/** Second-person release: signs the manifest's hash with a different key and writes a new bundle with approval.json. */
async function approveBundle(file, keys, approver, outPath) {
  const b = await readBundle(file), v = Provenance.verify(b.manifest);
  if (!v.ok) throw new Error('The bundle\'s manifest signature is not valid: ' + v.reason);
  if (!b.files.every(f => f.ok)) throw new Error('Files in the bundle don\'t match the manifest: ' + b.files.filter(f => !f.ok).map(f => f.name).join(', '));
  if (!b.manifest.release || !b.manifest.release.two_person) throw new Error('This bundle was not packed for two-person release.');
  if (keys.keyId === b.manifest.signature.key_id) throw new Error('The second approval must come from a different person (a different key) than the one who packed it.');
  const approval = Provenance.sign({ kind: 'release-approval', decision: 'release', manifest_sha256: b.manifestSha256, dataset: b.manifest.dataset, marking: b.manifest.marking || null, approver: { ...approver, key_id: keys.keyId }, at: new Date().toISOString() }, keys);
  const dir = (await (async () => { const raw = zlib.gunzipSync(fs.readFileSync(file)); return raw.toString('utf8', 0, 100).split('/')[0]; })());
  const entries = [...b.entries.entries()].filter(([n]) => n !== 'approval.json').map(([n, data]) => ({ name: `${dir}/${n}`, data }));
  entries.push({ name: `${dir}/approval.json`, data: Buffer.from(JSON.stringify(approval, null, 2) + '\n') });
  await writeTarGz(outPath, entries);
  return approval;
}
/** Full check of a bundle: files, manifest signature, and (for two-person bundles) the approval. */
async function checkBundle(file, pinnedKeys = []) {
  const b = await readBundle(file), sig = Provenance.verify(b.manifest), out = { ...b, signature: sig, released: true, approvalCheck: null };
  if (b.manifest.release && b.manifest.release.two_person) {
    if (!b.approval) { out.released = false; out.approvalCheck = { ok: false, reason: 'Waiting for a second person to approve the release.' }; }
    else {
      const av = Provenance.verify(b.approval), same = b.approval.manifest_sha256 === b.manifestSha256, other = b.approval.signature && b.approval.signature.key_id !== b.manifest.signature.key_id;
      out.approvalCheck = { ok: av.ok && same && other, reason: !av.ok ? av.reason : !same ? 'The approval is for a different manifest.' : !other ? 'Packed and approved with the same key.' : `Approved by ${b.approval.approver.name || b.approval.approver.user || ''} (key ${b.approval.signature.key_id}) on ${b.approval.at}` };
      out.released = out.approvalCheck.ok;
    }
  }
  out.ok = sig.ok && b.files.every(f => f.ok) && !b.extra.length && (!out.approvalCheck || out.approvalCheck.ok);
  return out;
}

/** Puts a classification marking line right after a dataset card's YAML front matter (which must stay first). */
function markCard(card, marking) { if (!marking) return card; const line = `> **${marking}**\n`; return /^---\n[\s\S]*?\n---\n/.test(card) ? card.replace(/^(---\n[\s\S]*?\n---\n)/, `$1\n${line}`) : line + '\n' + card; }

module.exports = { markCard, shareChecks, buildBundle, readBundle, approveBundle, checkBundle, writeTarGz, privacySummary, LICENSES, MIN_K };
