// Crypto helpers built on node:crypto only.
import crypto from 'node:crypto';

export const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
export const randKey = (prefix = 'awk') => `${prefix}_${crypto.randomBytes(32).toString('base64url')}`;

export function safeEq(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

// ---- request signing (HMAC-SHA256, the secret never crosses the wire) ----
export function signRequest(secret, { method, path, body = '', agent }) {
  const ts = String(Date.now()), nonce = crypto.randomBytes(12).toString('hex');
  const sig = crypto.createHmac('sha256', secret).update([method, path, ts, nonce, sha256(body)].join('\n')).digest('hex');
  return { 'x-aw-agent': agent, 'x-aw-ts': ts, 'x-aw-nonce': nonce, 'x-aw-sig': sig };
}
export function verifySig(secret, { method, path, body, ts, nonce, sig }) {
  const expect = crypto.createHmac('sha256', secret).update([method, path, ts, nonce, sha256(body || '')].join('\n')).digest('hex');
  return safeEq(expect, sig || '');
}

// ---- at-rest encryption (AES-256-GCM with a key derived from the hub secret) ----
export const deriveKey = (secret, info) => Buffer.from(crypto.hkdfSync('sha256', Buffer.from(secret), Buffer.alloc(0), Buffer.from(info), 32));
export function sealAtRest(key, text) {
  const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(text, 'utf8'), c.final()]);
  return 'rest1:' + Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64');
}
export function openAtRest(key, s) {
  if (typeof s !== 'string' || !s.startsWith('rest1:')) return s;
  const b = Buffer.from(s.slice(6), 'base64'), d = crypto.createDecipheriv('aes-256-gcm', key, b.subarray(0, 12));
  d.setAuthTag(b.subarray(12, 28));
  return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8');
}

// ---- end-to-end message encryption: X25519 + HKDF-SHA256 + AES-256-GCM ----
export function newKeypair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('x25519');
  return { public_key: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
    private_key: privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64') };
}
function shared(privB64, pubB64) {
  const priv = crypto.createPrivateKey({ key: Buffer.from(privB64, 'base64'), format: 'der', type: 'pkcs8' });
  const pub = crypto.createPublicKey({ key: Buffer.from(pubB64, 'base64'), format: 'der', type: 'spki' });
  return deriveKey(crypto.diffieHellman({ privateKey: priv, publicKey: pub }), 'agentwire-e2e-v1');
}
export function e2eEncrypt(kp, recipientPub, text) {
  const key = shared(kp.private_key, recipientPub);
  const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', key, iv);
  c.setAAD(Buffer.from('aw-e2e-1'));
  const ct = Buffer.concat([c.update(text, 'utf8'), c.final()]);
  return JSON.stringify({ aw_e2e: 1, from_pub: kp.public_key, to_pub: recipientPub, iv: iv.toString('base64'),
    tag: c.getAuthTag().toString('base64'), ct: ct.toString('base64') });
}
export const isE2E = (body) => typeof body === 'string' && body.startsWith('{"aw_e2e":1');
export function e2eDecrypt(kp, body) {
  const m = JSON.parse(body);
  const other = m.from_pub === kp.public_key ? m.to_pub : m.from_pub;
  const d = crypto.createDecipheriv('aes-256-gcm', shared(kp.private_key, other), Buffer.from(m.iv, 'base64'));
  d.setAAD(Buffer.from('aw-e2e-1')); d.setAuthTag(Buffer.from(m.tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(m.ct, 'base64')), d.final()]).toString('utf8');
}
