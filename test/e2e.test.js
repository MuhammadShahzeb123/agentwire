import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHub } from '../src/hub.js';
import { createClient } from '../src/client.js';
import { signRequest } from '../src/crypto.js';

const ADMIN = 'admin-secret-0123456789';
let base, hub, keys = {};
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-'));
test.before(async () => {
  hub = createHub({ token: ADMIN }); await new Promise(r => hub.server.listen(0, r));
  base = `http://127.0.0.1:${hub.server.address().port}`;
  const admin = createClient({ url: base, key: ADMIN, admin: true, home });
  for (const id of ['devin', 'grok', 'codex', 'claude']) keys[id] = (await admin.api('invite', { agent_id: id })).key;
});
test.after(() => hub.server.close());

// Compat remote MCP client: key in URL, no local crypto.
const rpc = async (agent, method, params, id = 1) => (await (await fetch(`${base}/mcp?key=${keys[agent]}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id, method, params }) })).json());
const tool = async (agent, name, args = {}) => { const r = await rpc(agent, 'tools/call', { name, arguments: args }); return { err: r.result.isError, data: r.result.isError ? r.result.content[0].text : JSON.parse(r.result.content[0].text) }; };

test('auth: rejects missing, wrong, replayed, stale and tampered requests', async () => {
  assert.equal((await fetch(base + '/mcp', { method: 'POST', body: '{}' })).status, 401);
  assert.equal((await fetch(base + '/mcp?key=awk_nope', { method: 'POST', body: '{}' })).status, 401);
  const body = '{"jsonrpc":"2.0","id":1,"method":"ping"}';
  const h = signRequest(keys.codex, { method: 'POST', path: '/mcp', body, agent: 'codex' });
  assert.equal((await fetch(base + '/mcp', { method: 'POST', headers: h, body })).status, 200);
  assert.equal((await fetch(base + '/mcp', { method: 'POST', headers: h, body })).status, 401, 'replay');
  const h2 = signRequest(keys.codex, { method: 'POST', path: '/mcp', body, agent: 'codex' });
  assert.equal((await fetch(base + '/mcp', { method: 'POST', headers: h2, body: body.replace('ping', 'tools/list') })).status, 401, 'tamper');
  const h3 = signRequest(keys.codex, { method: 'POST', path: '/mcp', body, agent: 'codex' }); h3['x-aw-ts'] = String(Date.now() - 3600e3);
  assert.equal((await fetch(base + '/mcp', { method: 'POST', headers: h3, body })).status, 401, 'stale');
  const h4 = signRequest(keys.codex, { method: 'POST', path: '/mcp', body, agent: 'devin' });
  assert.equal((await fetch(base + '/mcp', { method: 'POST', headers: h4, body })).status, 401, 'impersonation');
});

test('agents cannot use admin tools or pick another identity', async () => {
  assert.ok((await tool('devin', 'invite_agent', { agent_id: 'x' })).err);
  assert.equal((await tool('devin', 'whoami', { as: 'grok' })).data.agent_id, 'devin');
});

test('compat HTTP MCP: chat, wait, reply, threads, at-rest encryption', async () => {
  assert.equal((await rpc('devin', 'initialize', {})).result.serverInfo.name, 'agentwire');
  const waiting = tool('grok', 'wait_for_message', { timeout_seconds: 5 });
  const sent = (await tool('devin', 'send_message', { to: 'grok', body: 'book me a table' })).data;
  assert.equal((await waiting).data[0].body, 'book me a table');
  const row = hub.db.prepare('SELECT body FROM messages WHERE id=?').get(sent.id);
  assert.ok(row.body.startsWith('rest1:') && !row.body.includes('table'), 'encrypted at rest');
  assert.equal((await tool('grok', 'check_inbox')).data.length, 0);
  await tool('grok', 'reply', { message_id: sent.id, body: 'done' });
  assert.equal((await tool('devin', 'check_inbox')).data[0].thread_id, sent.thread_id);
  assert.equal((await tool('devin', 'get_thread', { thread_id: sent.thread_id })).data.length, 2);
});

test('revoked key stops working', async () => {
  const admin = createClient({ url: base, key: ADMIN, admin: true, home });
  const k = (await admin.api('invite', { agent_id: 'temp' })).key;
  assert.equal((await fetch(`${base}/api/whoami?key=${k}`)).status, 200);
  await admin.api('revoke', { agent_id: 'temp' });
  assert.equal((await fetch(`${base}/api/whoami?key=${k}`)).status, 401);
});

function stdio(agent) {
  const p = spawn(process.execPath, ['src/cli.js', 'mcp'], { env: { ...process.env, AGENTWIRE_URL: base, AGENTWIRE_KEY: keys[agent], AGENTWIRE_AGENT: agent, AGENTWIRE_HOME: home } });
  const lines = []; let buf = '';
  p.stdout.on('data', d => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { lines.push(JSON.parse(buf.slice(0, i))); buf = buf.slice(i + 1); } });
  let n = 0;
  const call = (method, params) => { const id = ++n; p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); return new Promise(r => { const t = setInterval(() => { const m = lines.find(l => l.id === id); if (m) { clearInterval(t); r(m); } }, 10); }); };
  const t = async (name, args = {}) => JSON.parse((await call('tools/call', { name, arguments: args })).result.content[0].text);
  return { p, call, t };
}

test('stdio clients: end-to-end encrypted round trip, hub only sees ciphertext', async () => {
  const claude = stdio('claude'), codex = stdio('codex');
  await claude.call('initialize', {}); await codex.call('initialize', {});
  const sent = await claude.t('send_message', { to: 'codex', body: 'secret plan from claude' });
  assert.equal(sent.encryption, 'end-to-end encrypted');
  const row = hub.db.prepare('SELECT body FROM messages WHERE id=?').get(sent.id);
  assert.ok(row.body.startsWith('{"aw_e2e":1') && !row.body.includes('secret'));
  const got = await codex.t('check_inbox');
  assert.equal(got[0].body, 'secret plan from claude'); assert.equal(got[0].e2e, true);
  const rep = await codex.t('reply', { message_id: sent.id, body: 'ack' });
  assert.equal(rep.encryption, 'end-to-end encrypted');
  assert.equal((await claude.t('check_inbox'))[0].body, 'ack');
  const thread = await claude.t('get_thread', { thread_id: sent.thread_id });
  assert.deepEqual(thread.map(m => m.body), ['secret plan from claude', 'ack']);
  // stdio -> compat client falls back to plaintext with a warning
  const fb = await claude.t('send_message', { to: 'devin', body: 'hi devin' });
  assert.match(fb.encryption, /WITHOUT end-to-end/);
  assert.equal((await tool('devin', 'check_inbox')).data[0].body, 'hi devin');
  claude.p.kill(); codex.p.kill();
});

test('not indexable', async () => {
  const r = await fetch(base + '/robots.txt'); assert.match(await r.text(), /Disallow: \//);
  assert.equal((await fetch(base + '/health')).headers.get('x-robots-tag'), 'noindex, nofollow');
});
