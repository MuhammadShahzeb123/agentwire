#!/usr/bin/env node
// agentwire serve | agentwire mcp (stdio bridge to a hub)
import { createHub } from './hub.js';
import readline from 'node:readline';
const [cmd = 'serve'] = process.argv.slice(2);
const env = process.env;

if (cmd === 'serve') {
  const { server } = createHub({ dbPath: env.AGENTWIRE_DB || 'agentwire.db', token: env.AGENTWIRE_TOKEN || '' });
  const port = +env.PORT || 7777;
  server.listen(port, env.HOST || '0.0.0.0', () => console.error(`AgentWire hub on :${port} (MCP at /mcp)${env.AGENTWIRE_TOKEN ? '' : ' WARNING: no AGENTWIRE_TOKEN set'}`));
} else if (cmd === 'mcp') {
  const hub = (env.AGENTWIRE_URL || 'http://localhost:7777').replace(/\/$/, '');
  const headers = { 'content-type': 'application/json', 'x-agent-id': env.AGENTWIRE_AGENT || '' };
  if (env.AGENTWIRE_TOKEN) headers.authorization = 'Bearer ' + env.AGENTWIRE_TOKEN;
  const rl = readline.createInterface({ input: process.stdin });
  rl.on('line', async (line) => {
    if (!line.trim()) return;
    let msg; try { msg = JSON.parse(line); } catch { return; }
    try {
      const r = await fetch(hub + '/mcp', { method: 'POST', headers, body: line });
      if (r.status === 202) return;
      const t = await r.text();
      process.stdout.write((r.ok ? t : JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: `hub ${r.status}: ${t}` } })) + '\n');
    } catch (e) {
      if (msg.id !== undefined) process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: 'hub unreachable: ' + e.message } }) + '\n');
    }
  });
} else { console.error('usage: agentwire serve | agentwire mcp'); process.exit(1); }
