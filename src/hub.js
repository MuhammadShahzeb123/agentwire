// AgentWire hub: REST API + MCP (streamable HTTP) over SQLite. Zero dependencies (Node 22.5+).
import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { TOOLS } from './tools.js';

export function createHub({ dbPath = ':memory:', token = '' } = {}) {
  const db = new DatabaseSync(dbPath);
  db.exec(`PRAGMA journal_mode=WAL;
  CREATE TABLE IF NOT EXISTS agents(id TEXT PRIMARY KEY, name TEXT, description TEXT, last_seen INTEGER);
  CREATE TABLE IF NOT EXISTS messages(id TEXT PRIMARY KEY, thread_id TEXT, sender TEXT, recipient TEXT,
    body TEXT, reply_to TEXT, created_at INTEGER, read_at INTEGER);
  CREATE INDEX IF NOT EXISTS ix_inbox ON messages(recipient, read_at);`);
  const waiters = new Map(); // agentId -> Set<fn>

  const now = () => Date.now();
  const touch = (id) => db.prepare('UPDATE agents SET last_seen=? WHERE id=?').run(now(), id);
  const api = {
    register({ agent_id, name, description = '' }) {
      if (!agent_id || !/^[\w.-]{1,64}$/.test(agent_id)) throw new Error('agent_id must be 1-64 chars [A-Za-z0-9_.-]');
      db.prepare(`INSERT INTO agents(id,name,description,last_seen) VALUES(?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET name=excluded.name, description=excluded.description, last_seen=excluded.last_seen`)
        .run(agent_id, name || agent_id, description, now());
      return { ok: true, agent_id };
    },
    list() {
      const t = now();
      return db.prepare('SELECT id,name,description,last_seen FROM agents ORDER BY id').all()
        .map(a => ({ ...a, online: t - a.last_seen < 120000 }));
    },
    send(from, { to, body, reply_to, thread_id }) {
      if (!from) throw new Error('sender agent id required');
      if (!to || !body) throw new Error('to and body are required');
      if (!db.prepare('SELECT 1 FROM agents WHERE id=?').get(to)) throw new Error(`unknown agent: ${to}`);
      if (!db.prepare('SELECT 1 FROM agents WHERE id=?').get(from)) api.register({ agent_id: from });
      if (reply_to && !thread_id) {
        const p = db.prepare('SELECT thread_id FROM messages WHERE id=?').get(reply_to);
        if (!p) throw new Error('reply_to message not found');
        thread_id = p.thread_id;
      }
      const m = { id: randomUUID(), thread_id: thread_id || randomUUID(), sender: from, recipient: to,
        body: String(body), reply_to: reply_to || null, created_at: now(), read_at: null };
      db.prepare('INSERT INTO messages VALUES(?,?,?,?,?,?,?,?)').run(m.id, m.thread_id, m.sender, m.recipient, m.body, m.reply_to, m.created_at, null);
      touch(from);
      for (const fn of waiters.get(to) || []) fn();
      return m;
    },
    reply(from, { message_id, body }) {
      const p = db.prepare('SELECT * FROM messages WHERE id=?').get(message_id);
      if (!p) throw new Error('message not found');
      const to = p.sender === from ? p.recipient : p.sender;
      return api.send(from, { to, body, reply_to: message_id, thread_id: p.thread_id });
    },
    inbox(agent, { unread_only = true, mark_read = true, limit = 50 } = {}) {
      if (!agent) throw new Error('agent id required');
      touch(agent);
      const rows = db.prepare(`SELECT * FROM messages WHERE recipient=? ${unread_only ? 'AND read_at IS NULL' : ''}
        ORDER BY created_at LIMIT ?`).all(agent, Math.min(+limit || 50, 500));
      if (mark_read && rows.length) {
        const st = db.prepare('UPDATE messages SET read_at=? WHERE id=? AND read_at IS NULL');
        const t = now(); for (const r of rows) st.run(t, r.id);
      }
      return rows;
    },
    thread(agent, { thread_id }) {
      return db.prepare('SELECT * FROM messages WHERE thread_id=? AND (sender=? OR recipient=?) ORDER BY created_at').all(thread_id, agent, agent);
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

  const authOk = (req, url) => {
    if (!token) return true;
    const h = req.headers.authorization || '';
    const got = h.startsWith('Bearer ') ? h.slice(7) : (req.headers['x-agentwire-token'] || url.searchParams.get('token') || '');
    const a = Buffer.from(String(got)), b = Buffer.from(token);
    return a.length === b.length && timingSafeEqual(a, b);
  };
  const agentOf = (req, url) => req.headers['x-agent-id'] || url.searchParams.get('agent') || '';

  async function callTool(name, args = {}, defaultAgent) {
    const me = args.as || defaultAgent;
    switch (name) {
      case 'register_agent': return api.register({ agent_id: args.agent_id || me, name: args.name, description: args.description });
      case 'list_agents': return api.list();
      case 'send_message': return api.send(me, args);
      case 'reply': return api.reply(me, args);
      case 'check_inbox': return api.inbox(me, args);
      case 'wait_for_message': return api.wait(me, args);
      case 'get_thread': return api.thread(me, args);
      case 'mark_read': return api.markRead(me, args);
      case 'whoami': return { agent_id: me || null };
      default: throw new Error(`unknown tool: ${name}`);
    }
  }

  async function handleRpc(msg, agent) {
    const { id, method, params = {} } = msg;
    const ok = (result) => ({ jsonrpc: '2.0', id, result });
    if (method === 'initialize') return ok({ protocolVersion: params.protocolVersion || '2025-03-26',
      capabilities: { tools: {} }, serverInfo: { name: 'agentwire', version: '0.1.0' },
      instructions: 'AgentWire: direct messages between AI agents. Call whoami, then check_inbox or wait_for_message; send with send_message.' });
    if (method === 'ping') return ok({});
    if (method === 'tools/list') return ok({ tools: TOOLS });
    if (method === 'tools/call') {
      try {
        const r = await callTool(params.name, params.arguments || {}, agent);
        return ok({ content: [{ type: 'text', text: JSON.stringify(r, null, 2) }] });
      } catch (e) { return ok({ content: [{ type: 'text', text: 'Error: ' + e.message }], isError: true }); }
    }
    if (id === undefined) return null; // notification
    return { jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found: ' + method } };
  }

  const readBody = (req) => new Promise((res, rej) => { let d = ''; req.on('data', c => { d += c; if (d.length > 1e6) rej(new Error('too large')); }); req.on('end', () => res(d)); });
  const send = (res, code, obj, extra = {}) => { res.writeHead(code, { 'content-type': 'application/json', ...extra }); res.end(obj === undefined ? '' : JSON.stringify(obj)); };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    try {
      if (url.pathname === '/health') return send(res, 200, { ok: true, name: 'agentwire' });
      if (!authOk(req, url)) return send(res, 401, { error: 'unauthorized' });
      const agent = agentOf(req, url);
      if (url.pathname === '/mcp') {
        if (req.method !== 'POST') return send(res, 405, { error: 'use POST' });
        const msg = JSON.parse(await readBody(req) || 'null');
        const sid = req.headers['mcp-session-id'] || randomUUID();
        if (Array.isArray(msg)) {
          const out = (await Promise.all(msg.map(m => handleRpc(m, agent)))).filter(Boolean);
          return out.length ? send(res, 200, out, { 'mcp-session-id': sid }) : send(res, 202);
        }
        const out = await handleRpc(msg, agent);
        return out ? send(res, 200, out, { 'mcp-session-id': sid }) : send(res, 202);
      }
      const m = url.pathname.match(/^\/api\/(\w+)$/);
      if (m) {
        const args = req.method === 'POST' ? JSON.parse(await readBody(req) || '{}') : Object.fromEntries(url.searchParams);
        delete args.token;
        const name = { register: 'register_agent', agents: 'list_agents', send: 'send_message', reply: 'reply', inbox: 'check_inbox',
          wait: 'wait_for_message', thread: 'get_thread', read: 'mark_read' }[m[1]];
        if (!name) return send(res, 404, { error: 'not found' });
        try { return send(res, 200, await callTool(name, args, agent)); }
        catch (e) { return send(res, 400, { error: e.message }); }
      }
      send(res, 404, { error: 'not found' });
    } catch (e) { send(res, 400, { error: e.message }); }
  });
  return { server, api, db, handleRpc };
}
