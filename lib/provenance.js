// Signed provenance manifests. The server holds an Ed25519 key pair (created on first start in data/keys/, private key
// file mode 600, never sent anywhere). A manifest records what went in, every step and its settings, what came out
// (SHA-256 hashes) and which engine ran it; the signature covers all of that, so changing any byte of the manifest
// is detectable, and the hashes tie it to the exact files. scripts/verify-manifest.js checks one offline.
'use strict';
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

/** Deterministic JSON: object keys sorted, undefined dropped. The signature is over this text. */
function canonical(v) {
  if (Array.isArray(v)) return '[' + v.map(x => (x === undefined ? 'null' : canonical(x))).join(',') + ']';
  if (v && typeof v === 'object') return '{' + Object.keys(v).sort().filter(k => v[k] !== undefined).map(k => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}';
  return JSON.stringify(v === undefined ? null : v);
}

function loadKeys(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const kf = path.join(dir, 'provenance.key'), pf = path.join(dir, 'provenance.pub');
  if (!fs.existsSync(kf)) {
    const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
    fs.writeFileSync(kf, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
    fs.writeFileSync(pf, publicKey.export({ type: 'spki', format: 'pem' }), { mode: 0o644 });
  }
  const privateKey = crypto.createPrivateKey(fs.readFileSync(kf)), publicKey = crypto.createPublicKey(fs.readFileSync(pf));
  const spki = publicKey.export({ type: 'spki', format: 'der' });
  return { privateKey, publicKey, publicPem: fs.readFileSync(pf, 'utf8'), publicB64: spki.toString('base64'), keyId: keyIdOf(spki) };
}
const keyIdOf = (spkiDer) => crypto.createHash('sha256').update(spkiDer).digest('hex').slice(0, 16);

function sign(manifest, keys) {
  const body = { ...manifest }; delete body.signature;
  const value = crypto.sign(null, Buffer.from(canonical(body), 'utf8'), keys.privateKey).toString('base64');
  return { ...body, signature: { algorithm: 'Ed25519', key_id: keys.keyId, public_key: keys.publicB64, value, covers: 'every other field, as canonical JSON (keys sorted)' } };
}

/** { ok, keyId, reason }. publicKey (KeyObject or PEM) pins the expected key; otherwise the embedded key is used. */
function verify(manifest, publicKey) {
  const sig = manifest && manifest.signature;
  if (!sig || sig.algorithm !== 'Ed25519' || !sig.value || !sig.public_key) return { ok: false, reason: 'The manifest has no Ed25519 signature.' };
  let key;
  try { key = publicKey ? (typeof publicKey === 'string' ? crypto.createPublicKey(publicKey) : publicKey) : crypto.createPublicKey({ key: Buffer.from(sig.public_key, 'base64'), format: 'der', type: 'spki' }); }
  catch { return { ok: false, reason: 'The public key could not be read.' }; }
  const keyId = keyIdOf(key.export({ type: 'spki', format: 'der' }));
  if (publicKey && sig.key_id && sig.key_id !== keyId) return { ok: false, keyId, reason: `Signed with key ${sig.key_id}, not the expected key ${keyId}.` };
  const body = { ...manifest }; delete body.signature;
  let ok = false; try { ok = crypto.verify(null, Buffer.from(canonical(body), 'utf8'), key, Buffer.from(sig.value, 'base64')); } catch {}
  return ok ? { ok: true, keyId } : { ok: false, keyId, reason: 'The signature does not match: the manifest was changed after it was signed, or signed by another key.' };
}

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256'), s = fs.createReadStream(file, { highWaterMark: 1 << 22 });
    s.on('data', (c) => h.update(c)); s.on('error', reject); s.on('end', () => resolve(h.digest('hex')));
  });
}

/** Identifies the engine that ran the steps: a hash of js/etl.js, so a manifest names the exact code. */
function engineInfo(root) {
  const src = fs.readFileSync(path.join(root, 'js', 'etl.js'));
  return { name: 'QuantETL', etl_sha256: crypto.createHash('sha256').update(src).digest('hex'), node: process.version };
}

module.exports = { canonical, loadKeys, sign, verify, sha256File, engineInfo, keyIdOf };
