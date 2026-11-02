// Local AgentWire client: signs every request (HMAC) and does end-to-end encryption transparently.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { signRequest, newKeypair, e2eEncrypt, e2eDecrypt, isE2E } from './crypto.js';

export function createClient({ url, agent, key, home = path.join(os.homedir(), '.agentwire'), admin = false }) {
  url = url.replace(/\/$/, '');
  let kp = null;
  if (!admin) {
    const f = path.join(home, 'keys', `${agent}.json`);
    if (fs.existsSync(f)) kp = JSON.parse(fs.readFileSync(f, 'utf8'));
    else { kp = newKeypair(); fs.mkdirSync(path.dirname(f), { recursive: true, mode: 0o700 }); fs.writeFileSync(f, JSON.stringify(kp), { mode: 0o600 }); }
  }
  const signer = admin ? 'admin' : agent;

  async function request(p, body = '') {
    const method = body ? 'POST' : 'GET';
    const headers = { 'content-type': 'application/json', ...signRequest(key, { method, path: p, body, agent: signer }) };
    const r = await fetch(url + p, { method, headers, body: body || undefined });
    return { status: r.status, text: await r.text() };
  }
  async function api(name, args = {}) {
    const r = await request('/api/' + name, JSON.stringify(args));
    const j = JSON.parse(r.text); if (r.status !== 200) throw new Error(j.error || r.text); return j;
  }

  const decryptDeep = (v) => {
    if (Array.isArray(v)) return v.map(decryptDeep);
    if (v && typeof v === 'object' && typeof v.body === 'string' && isE2E(v.body)) {
      try { return { ...v, body: e2eDecrypt(kp, v.body), e2e: true }; } catch { return { ...v, body: '[could not decrypt]', e2e: true }; }
    }
    return v;
  };
  let published = false;
  async function publish() { if (!published && kp) { await api('register', { public_key: kp.public_key }); published = true; } }
  async function pubOf(id) { return (await api('agents')).find(a => a.id === id)?.public_key || null; }

  // Rewrites outgoing tool calls and incoming results. Returns the JSON-RPC response object.
  async function rpc(msg) {
    if (msg.method === 'initialize') await publish().catch(() => {});
    let note = null;
    if (msg.method === 'tools/call' && kp) {
      const a = { ...(msg.params.arguments || {}) };
      if (msg.params.name === 'send_message' || msg.params.name === 'reply') {
        let to = a.to;
        if (msg.params.name === 'reply') { const m = await api('message', { message_id: a.message_id }); to = m.sender === agent ? m.recipient : m.sender; }
        const pub = to && a.body ? await pubOf(to) : null;
        if (pub) { a.body = e2eEncrypt(kp, pub, String(a.body)); note = 'end-to-end encrypted'; }
        else note = `sent WITHOUT end-to-end encryption: ${to} has no public key (remote/compat client). Hub encrypts it at rest only.`;
        msg = { ...msg, params: { ...msg.params, arguments: a } };
      }
    }
    const r = await request('/mcp', JSON.stringify(msg));
    if (r.status === 202) return null;
    if (r.status !== 200) return { jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: `hub ${r.status}: ${r.text}` } };
    const res = JSON.parse(r.text);
    const c = res.result?.content?.[0];
    if (kp && c?.type === 'text' && !res.result.isError) {
      try { let d = decryptDeep(JSON.parse(c.text)); if (note && d && !Array.isArray(d)) d = { ...d, encryption: note }; c.text = JSON.stringify(d, null, 2); } catch {}
    }
    return res;
  }
  return { request, api, rpc, publish, kp };
}
