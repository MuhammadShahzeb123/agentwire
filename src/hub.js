// AgentWire hub: REST API + MCP (streamable HTTP) over SQLite. Zero dependencies (Node 22.5+).
import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { TOOLS } from './tools.js';
import { sha256, randKey, safeEq, verifySig, deriveKey, sealAtRest, openAtRest, isE2E } from './crypto.js';

const SKEW_MS = 5 * 60 * 1000;

export function createHub({ dbPath = ':memory:', token, allowBearer = true } = {}) {
  if (!token || token.length < 16) throw new Error('AGENTWIRE_TOKEN (admin secret, 16+ chars) is required');
  const restKey = deriveKey(token, 'agentwire-at-rest-v1');
  const db = new DatabaseSync(dbPath);
  db.exec(`PRAGMA journal_mode=WAL;
  CREATE TABLE IF NOT EXISTS agents(id TEXT PRIMARY KEY, name TEXT, description TEXT, last_seen INTEGER);
  CREATE TABLE IF NOT EXISTS messages(id TEXT PRIMARY KEY, thread_id TEXT, sender TEXT, recipient TEXT,
    body TEXT, reply_to TEXT, created_at INTEGER, read_at INTEGER);
  CREATE INDEX IF NOT EXISTS ix_inbox ON messages(recipient, read_at);`);
  const cols = db.prepare('PRAGMA table_info(agents)').all().map(c => c.name);
  for (const c of ['key_hash', 'key_enc', 'public_key']) if (!cols.includes(c)) db.exec(`ALTER TABLE agents ADD COLUMN ${c} TEXT`);
  const waiters = new Map();
  const nonces = new Map();

  const now = () => Date.now();
  const touch = (id) => db.prepare('UPDATE agents SET last_seen=? WHERE id=?').run(now(), id);
  const getAgent = (id) => db.prepare('SELECT * FROM agents WHERE id=?').get(id);
  const out = (m) => m && ({ ...m, body: openAtRest(restKey, m.body), e2e: isE2E(m.body) });
  const validId = (id) => { if (!id || !/^[\w.-]{1,64}$/.test(id)) throw new Error('agent_id must be 1-64 chars [A-Za-z0-9_.-]'); };

  const api = {
    invite({ agent_id, name, description = '' }) {
      validId(agent_id);
      const key = randKey('awk');
      db.prepare(`INSERT INTO agents(id,name,description,last_seen,key_hash,key_enc) VALUES(?,?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET key_hash=excluded.key_hash, key_enc=excluded.key_enc,
        description=CASE WHEN excluded.description<>'' THEN excluded.description ELSE agents.description END`)
        .run(agent_id, name || agent_id, description, 0, sha256(key), sealAtRest(restKey, key));
      return { agent_id, key, note: 'Store this key now. It is shown once.' };
    },
    revoke({ agent_id }) { return { revoked: Number(db.prepare('UPDATE agents SET key_hash=NULL, key_enc=NULL WHERE id=?').run(agent_id).changes) }; },
    register(me, { name, description, public_key }) {
      if (!getAgent(me)) throw new Error('unknown agent; ask the hub admin to run: agentwire invite ' + me);
      db.prepare(`UPDATE agents SET name=COALESCE(?,name), description=COALESCE(?,description),
        public_key=COALESCE(?,public_key), last_seen=? WHERE id=?`).run(name ?? null, description ?? null, public_key ?? null, now(), me);
      return { ok: true, agent_id: me, e2e: !!getAgent(me).public_key };
    },
    list() {
      const t = now();
      return db.prepare('SELECT id,name,description,last_seen,public_key FROM agents WHERE key_hash IS NOT NULL ORDER BY id').all()
        .map(a => ({ ...a, online: t - a.last_seen < 120000, e2e: !!a.public_key }));
    },
    getMessage(me, { message_id }) {
      const m = db.prepare('SELECT * FROM messages WHERE id=? AND (sender=? OR recipient=?)').get(message_id, me, me);
      if (!m) throw new Error('message not found'); return out(m);
    },
    send(from, { to, body, reply_to, thread_id }) {
      if (!to || !body) throw new Error('to and body are required');
      if (!getAgent(to)?.key_hash) throw new Error(`unknown agent: ${to}`);
      if (reply_to && !thread_id) {
        const p = db.prepare('SELECT thread_id FROM messages WHERE id=?').get(reply_to);
        if (!p) throw new Error('reply_to message not found');
        thread_id = p.thread_id;
      }
      body = String(body);
      const stored = isE2E(body) ? body : sealAtRest(restKey, body);
      const m = { id: randomUUID(), thread_id: thread_id || randomUUID(), sender: from, recipient: to,
        body: stored, reply_to: reply_to || null, created_at: now(), read_at: null };
      db.prepare('INSERT INTO messages VALUES(?,?,?,?,?,?,?,?)').run(m.id, m.thread_id, m.sender, m.recipient, m.body, m.reply_to, m.created_at, null);
      touch(from);
      for (const fn of waiters.get(to) || []) fn();
      return out(m);
    },
    reply(from, { message_id, body }) {
      const p = db.prepare('SELECT * FROM messages WHERE id=? AND (sender=? OR recipient=?)').get(message_id, from, from);
      if (!p) throw new Error('message not found');
      const to = p.sender === from ? p.recipient : p.sender;
      return api.send(from, { to, body, reply_to: message_id, thread_id: p.thread_id });
    },
    inbox(agent, { unread_only = true, mark_read = true, limit = 50 } = {}) {
      touch(agent);
      const rows = db.prepare(`SELECT * FROM messages WHERE recipient=? ${unread_only ? 'AND read_at IS NULL' : ''}
        ORDER BY created_at LIMIT ?`).all(agent, Math.min(+limit || 50, 500));
      if (mark_read && rows.length) {
        const st = db.prepare('UPDATE messages SET read_at=? WHERE id=? AND read_at IS NULL');
        const t = now(); for (const r of rows) st.run(t, r.id);
      }
      return rows.map(out);
    },
    thread(agent, { thread_id }) {
      return db.prepare('SELECT * FROM messages WHERE thread_id=? AND (sender=? OR recipient=?) ORDER BY created_at').all(thread_id, agent, agent).map(out);
    },
    markRead(agent, { message_ids = [] }) {
      const st = db.prepare('UPDATE messages SET read_at=? WHERE id=? AND recipient=?');
      let n = 0; for (const id of message_ids) n += Number(st.run(now(), id, agent).changes); return { marked: n };
    },
    async wait(agent, { timeout_seconds = 30 } = {}) {
      const got = api.inbox(agent);
      if (got.length) return got;
      const ms = Math.min(Math.max(+timeout_seconds || 30, 1), 300) * 1000;
      await new Promise(res => {
        const set = waiters.get(agent) || new Set(); waiters.set(agent, set);
        const done = () => { clearTimeout(t); set.delete(done); res(); };
        const t = setTimeout(done, ms); set.add(done);
      });
      return api.inbox(agent);
    },
  };

  // Returns { agent, admin, mode } or null.
  function authenticate(req, url, body) {
    const h = req.headers;
    if (h['x-aw-sig']) {
      const id = String(h['x-aw-agent'] || ''), ts = +h['x-aw-ts'], nonce = String(h['x-aw-nonce'] || '');
      if (!ts || Math.abs(now() - ts) > SKEW_MS || !nonce || nonces.has(nonce)) return null;
      let secret, admin = false;
      if (id === 'admin') { secret = token; admin = true; }
      else { const a = getAgent(id); if (!a?.key_enc) return null; secret = openAtRest(restKey, a.key_enc); }
      if (!verifySig(secret, { method: req.method, path: url.pathname + url.search, body, ts: h['x-aw-ts'], nonce, sig: h['x-aw-sig'] })) return null;
      nonces.set(nonce, ts + SKEW_MS);
      if (nonces.size > 10000) for (const [n, exp] of nonces) if (exp < now()) nonces.delete(n);
      return { agent: admin ? (h['x-agent-id'] || url.searchParams.get('agent') || '') : id, admin, mode: 'hmac' };
    }
    if (!allowBearer) return null;
    const auth = h.authorization || '';
    const secret = auth.startsWith('Bearer ') ? auth.slice(7) : (url.searchParams.get('key') || url.searchParams.get('token') || '');
    if (!secret) return null;
    if (safeEq(secret, token)) return { agent: h['x-agent-id'] || url.searchParams.get('agent') || '', admin: true, mode: 'bearer' };
    const a = db.prepare('SELECT id FROM agents WHERE key_hash=?').get(sha256(secret));
    return a ? { agent: a.id, admin: false, mode: 'bearer' } : null;
  }

  async function callTool(name, args = {}, ctx) {
    let me = ctx.agent;
    if (ctx.admin && args.as) me = args.as;
    const need = () => { if (!me) throw new Error('no agent identity; use an agent key'); return me; };
    switch (name) {
      case 'register_agent': return api.register(need(), args);
      case 'list_agents': return api.list();
      case 'send_message': return api.send(need(), args);
      case 'reply': return api.reply(need(), args);
      case 'check_inbox': return api.inbox(need(), args);
      case 'wait_for_message': return api.wait(need(), args);
      case 'get_thread': return api.thread(need(), args);
      case 'get_message': return api.getMessage(need(), args);
      case 'mark_read': return api.markRead(need(), args);
      case 'whoami': return { agent_id: me || null, admin: ctx.admin, auth: ctx.mode };
      case 'invite_agent': if (!ctx.admin) throw new Error('admin only'); return api.invite(args);
      case 'revoke_agent': if (!ctx.admin) throw new Error('admin only'); return api.revoke(args);
      default: throw new Error(`unknown tool: ${name}`);
    }
  }

  async function handleRpc(msg, ctx) {
    const { id, method, params = {} } = msg || {};
    const ok = (result) => ({ jsonrpc: '2.0', id, result });
    if (method === 'initialize') return ok({ protocolVersion: params.protocolVersion || '2025-03-26',
      capabilities: { tools: {} }, serverInfo: { name: 'agentwire', version: '0.2.0' },
      instructions: 'AgentWire: direct messages between AI agents. Call whoami, then check_inbox or wait_for_message; send with send_message.' });
    if (method === 'ping') return ok({});
    if (method === 'tools/list') return ok({ tools: TOOLS.filter(t => ctx.admin || !t.admin).map(({ admin, ...t }) => t) });
    if (method === 'tools/call') {
      try {
        const r = await callTool(params.name, params.arguments || {}, ctx);
        return ok({ content: [{ type: 'text', text: JSON.stringify(r, null, 2) }] });
      } catch (e) { return ok({ content: [{ type: 'text', text: 'Error: ' + e.message }], isError: true }); }
    }
    if (id === undefined) return null;
    return { jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found: ' + method } };
  }

  const readBody = (req) => new Promise((res, rej) => { let d = ''; req.on('data', c => { d += c; if (d.length > 1e6) rej(new Error('too large')); }); req.on('end', () => res(d)); });
  const send = (res, code, obj, extra = {}) => { res.writeHead(code, { 'content-type': 'application/json', 'x-robots-tag': 'noindex, nofollow', ...extra }); res.end(obj === undefined ? '' : JSON.stringify(obj)); };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    try {
      if (url.pathname === '/robots.txt') { res.writeHead(200, { 'content-type': 'text/plain', 'x-robots-tag': 'noindex, nofollow' }); return res.end('User-agent: *\nDisallow: /\n'); }
      if (url.pathname === '/health') return send(res, 200, { ok: true, name: 'agentwire', version: '0.2.0' });
      const raw = req.method === 'POST' ? await readBody(req) : '';
      const ctx = authenticate(req, url, raw);
      if (!ctx) return send(res, 401, { error: 'unauthorized' });
      if (url.pathname === '/mcp') {
        if (req.method !== 'POST') return send(res, 405, { error: 'use POST' });
        const msg = JSON.parse(raw || 'null');
        const sid = req.headers['mcp-session-id'] || randomUUID();
        if (Array.isArray(msg)) {
          const r = (await Promise.all(msg.map(m => handleRpc(m, ctx)))).filter(Boolean);
          return r.length ? send(res, 200, r, { 'mcp-session-id': sid }) : send(res, 202);
        }
        const r = await handleRpc(msg, ctx);
        return r ? send(res, 200, r, { 'mcp-session-id': sid }) : send(res, 202);
      }
      const m = url.pathname.match(/^\/api\/(\w+)$/);
      if (m) {
        const args = req.method === 'POST' ? JSON.parse(raw || '{}') : Object.fromEntries(url.searchParams);
        delete args.token; delete args.key;
        const name = { register: 'register_agent', agents: 'list_agents', send: 'send_message', reply: 'reply', inbox: 'check_inbox',
          wait: 'wait_for_message', thread: 'get_thread', message: 'get_message', read: 'mark_read', whoami: 'whoami',
          invite: 'invite_agent', revoke: 'revoke_agent' }[m[1]];
        if (!name) return send(res, 404, { error: 'not found' });
        try { return send(res, 200, await callTool(name, args, ctx)); }
        catch (e) { return send(res, 400, { error: e.message }); }
      }
      send(res, 404, { error: 'not found' });
    } catch (e) { send(res, 400, { error: e.message }); }
  });
  return { server, api, db, handleRpc };
}
