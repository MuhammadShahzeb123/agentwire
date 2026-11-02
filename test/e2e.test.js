import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHub } from '../src/hub.js';

const TOKEN = 'secret';
let base, hub;
test.before(async () => { hub = createHub({ token: TOKEN }); await new Promise(r => hub.server.listen(0, r)); base = `http://127.0.0.1:${hub.server.address().port}`; });
test.after(() => hub.server.close());

const rpc = async (agent, method, params, id = 1) => {
  const r = await fetch(`${base}/mcp?agent=${agent}`, { method: 'POST', headers: { authorization: 'Bearer ' + TOKEN, 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id, method, params }) });
  return r.json();
};
const tool = async (agent, name, args = {}) => { const r = await rpc(agent, 'tools/call', { name, arguments: args }); return { err: r.result.isError, data: r.result.isError ? r.result.content[0].text : JSON.parse(r.result.content[0].text) }; };

test('rejects bad token', async () => { assert.equal((await fetch(base + '/mcp', { method: 'POST', body: '{}' })).status, 401); });

test('HTTP MCP: initialize, list tools, two agents chat', async () => {
  assert.equal((await rpc('devin', 'initialize', {})).result.serverInfo.name, 'agentwire');
  assert.ok((await rpc('devin', 'tools/list', {})).result.tools.some(t => t.name === 'wait_for_message'));
  await tool('devin', 'register_agent', { description: 'flagship models' });
  await tool('grok', 'register_agent', { description: 'browser + accounts' });
  assert.equal((await tool('devin', 'list_agents')).data.length, 2);
  assert.ok((await tool('devin', 'send_message', { to: 'nobody', body: 'x' })).err);
  const waiting = tool('grok', 'wait_for_message', { timeout_seconds: 5 });
  const sent = (await tool('devin', 'send_message', { to: 'grok', body: 'book me a table' })).data;
  const got = (await waiting).data;
  assert.equal(got[0].body, 'book me a table');
  assert.equal((await tool('grok', 'check_inbox')).data.length, 0, 'marked read');
  await tool('grok', 'reply', { message_id: sent.id, body: 'done' });
  const back = (await tool('devin', 'check_inbox')).data;
  assert.equal(back[0].body, 'done'); assert.equal(back[0].thread_id, sent.thread_id);
  assert.equal((await tool('devin', 'get_thread', { thread_id: sent.thread_id })).data.length, 2);
});

test('offline queue + REST API', async () => {
  const h = { authorization: 'Bearer ' + TOKEN, 'content-type': 'application/json', 'x-agent-id': 'codex' };
  await fetch(base + '/api/register', { method: 'POST', headers: h, body: '{}' });
  await fetch(base + '/api/send', { method: 'POST', headers: { ...h, 'x-agent-id': 'claude' }, body: JSON.stringify({ to: 'codex', body: 'hi while you were away' }) });
  const inbox = await (await fetch(base + '/api/inbox', { headers: h })).json();
  assert.equal(inbox[0].body, 'hi while you were away');
});

test('stdio MCP bridge end to end', async () => {
  const p = spawn(process.execPath, ['src/cli.js', 'mcp'], { env: { ...process.env, AGENTWIRE_URL: base, AGENTWIRE_TOKEN: TOKEN, AGENTWIRE_AGENT: 'claude' } });
  const lines = []; let buf = '';
  p.stdout.on('data', d => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { lines.push(JSON.parse(buf.slice(0, i))); buf = buf.slice(i + 1); } });
  const call = (id, method, params) => { p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); return new Promise(r => { const t = setInterval(() => { const m = lines.find(l => l.id === id); if (m) { clearInterval(t); r(m); } }, 10); }); };
  await call(1, 'initialize', {});
  await call(2, 'tools/call', { name: 'register_agent', arguments: {} });
  const r = await call(3, 'tools/call', { name: 'send_message', arguments: { to: 'devin', body: 'from claude via stdio' } });
  assert.ok(!r.result.isError, JSON.stringify(r));
  assert.equal((await tool('devin', 'check_inbox')).data[0].body, 'from claude via stdio');
  p.kill();
});
