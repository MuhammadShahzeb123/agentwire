#!/usr/bin/env node
// agentwire serve | mcp | invite <id> | revoke <id> | agents
import { createHub } from './hub.js';
import { createClient } from './client.js';
import readline from 'node:readline';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
const [cmd = 'serve', ...rest] = process.argv.slice(2);
const env = process.env;
const home = env.AGENTWIRE_HOME || path.join(os.homedir(), '.agentwire');
const adminToken = () => env.AGENTWIRE_TOKEN || (fs.existsSync(path.join(home, 'token')) ? fs.readFileSync(path.join(home, 'token'), 'utf8').trim() : '');
const hubUrl = () => env.AGENTWIRE_URL || `http://localhost:${env.PORT || 7777}`;
const readSecret = (v, f) => v || (f && fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim() : '');

if (cmd === 'serve') {
  const { server } = createHub({ dbPath: env.AGENTWIRE_DB || path.join(home, 'agentwire.db'), token: adminToken(),
    allowBearer: env.AGENTWIRE_ALLOW_BEARER !== '0' });
  const port = +env.PORT || 7777;
  server.listen(port, env.HOST || '0.0.0.0', () => console.error(`AgentWire hub on :${port} (MCP at /mcp)`));
} else if (cmd === 'mcp') {
  const key = readSecret(env.AGENTWIRE_KEY, env.AGENTWIRE_KEY_FILE);
  if (!env.AGENTWIRE_AGENT || !key) { console.error('Set AGENTWIRE_URL, AGENTWIRE_AGENT and AGENTWIRE_KEY (or AGENTWIRE_KEY_FILE)'); process.exit(1); }
  const client = createClient({ url: hubUrl(), agent: env.AGENTWIRE_AGENT, key, home });
  const rl = readline.createInterface({ input: process.stdin });
  rl.on('line', async (line) => {
    let msg; try { msg = JSON.parse(line); } catch { return; }
    try { const r = await client.rpc(msg); if (r) process.stdout.write(JSON.stringify(r) + '\n'); }
    catch (e) { if (msg.id !== undefined) process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: e.message } }) + '\n'); }
  });
} else if (['invite', 'revoke', 'agents'].includes(cmd)) {
  const client = createClient({ url: hubUrl(), key: adminToken(), home, admin: true });
  const args = cmd === 'agents' ? {} : { agent_id: rest[0], description: rest.slice(1).join(' ') };
  const r = await client.api(cmd, args).catch(e => { console.error(e.message); process.exit(1); });
  if (cmd === 'invite') {
    console.log(`Agent:  ${r.agent_id}\nKey:    ${r.key}\n\nShown once. Give it only to that agent.`);
    console.log(`Local MCP (encrypted): AGENTWIRE_URL=<hub> AGENTWIRE_AGENT=${r.agent_id} AGENTWIRE_KEY=<key> npx -y github:MuhammadShahzeb123/agentwire mcp`);
    console.log(`Remote MCP (compat, key in URL): <hub>/mcp?key=<key>`);
  } else console.log(JSON.stringify(r, null, 2));
} else { console.error('usage: agentwire serve | mcp | invite <agent-id> [description] | revoke <agent-id> | agents'); process.exit(1); }
