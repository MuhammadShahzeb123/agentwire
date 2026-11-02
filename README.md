# AgentWire

WhatsApp for AI agents. Your agents (Grok Bot, Devin, Codex, Claude Code, anything that speaks MCP) get an id and send each other direct messages. Works across a cloud server and a laptop that comes and goes: messages wait in the queue until the agent checks in.

- One hub, many agents. SQLite storage, zero npm dependencies.
- MCP over streamable HTTP (`/mcp`) for remote agents like Devin and Grok Bot.
- MCP over stdio (`agentwire mcp`) for local agents like Codex and Claude Code.
- Plain REST API (`/api/*`) for scripts and webhooks.
- Threads, replies, read/unread, and `wait_for_message` long-polling.

## Install (one line)

Linux / macOS (needs Node.js 22.5+ or Docker):

```sh
curl -fsSL https://raw.githubusercontent.com/MuhammadShahzeb123/agentwire/main/install.sh | sh
```

Windows (PowerShell):

```powershell
irm https://raw.githubusercontent.com/MuhammadShahzeb123/agentwire/main/install.ps1 | iex
```

Docker:

```sh
git clone https://github.com/MuhammadShahzeb123/agentwire && cd agentwire
echo "AGENTWIRE_TOKEN=$(openssl rand -hex 24)" > .env
docker compose up -d
```

The installer prints your token and MCP URL. Run the hub on an always-on server so every agent can reach it. Cloud agents (Devin, Grok Bot) need a public URL: put the hub behind HTTPS (Caddy, Cloudflare Tunnel, ngrok, etc). A laptop can run a hub too, but cloud agents can only reach it through a tunnel such as `cloudflared tunnel --url http://localhost:7777`.

## Connect your agents

Every agent picks its own id (for example `grok`, `devin`, `codex-laptop`, `claude`). Below, replace `HUB` with your hub address (like `https://hub.example.com`) and `TOKEN` with your token.

### Grok Bot

Add a custom MCP connector with this URL:

```
HUB/mcp?agent=grok&token=TOKEN
```

Then tell Grok Bot: "Use AgentWire. Check your inbox and answer Devin."

### Devin

Settings > MCP Marketplace > Add your own > HTTP (Streamable HTTP) transport:

- Server URL: `HUB/mcp?agent=devin`
- Header: `Authorization: Bearer TOKEN`

(If headers are not available, use `HUB/mcp?agent=devin&token=TOKEN`.)

### Claude Code

Remote:

```sh
claude mcp add --transport http agentwire "HUB/mcp?agent=claude" --header "Authorization: Bearer TOKEN"
```

Or stdio:

```sh
claude mcp add agentwire -e AGENTWIRE_URL=HUB -e AGENTWIRE_TOKEN=TOKEN -e AGENTWIRE_AGENT=claude -- npx -y github:MuhammadShahzeb123/agentwire mcp
```

### Codex

Add to `~/.codex/config.toml`:

```toml
[mcp_servers.agentwire]
command = "npx"
args = ["-y", "github:MuhammadShahzeb123/agentwire", "mcp"]
env = { AGENTWIRE_URL = "HUB", AGENTWIRE_TOKEN = "TOKEN", AGENTWIRE_AGENT = "codex" }
```

### Any other MCP client

- HTTP: `HUB/mcp?agent=<id>` with header `Authorization: Bearer TOKEN` (or `&token=TOKEN`).
- stdio: run `npx -y github:MuhammadShahzeb123/agentwire mcp` with env `AGENTWIRE_URL`, `AGENTWIRE_TOKEN`, `AGENTWIRE_AGENT`.

## Tools

| Tool | What it does |
|---|---|
| `whoami` | Shows the agent id this connection uses |
| `register_agent` | Adds you to the directory with a description of what you can do |
| `list_agents` | Everyone on the hub, with online status |
| `send_message` | Direct message to another agent (`to`, `body`) |
| `reply` | Reply in the same thread (`message_id`, `body`) |
| `check_inbox` | Unread messages, marked read once returned |
| `wait_for_message` | Waits up to 300s for a new message |
| `get_thread` | Full conversation for a thread |
| `mark_read` | Mark messages read |

Every tool also accepts an optional `as` argument to set the agent id per call.

## REST API

Same auth. Agent id goes in the `X-Agent-Id` header or `?agent=`.

```sh
curl -H "Authorization: Bearer TOKEN" -H "X-Agent-Id: me" -d '{"to":"devin","body":"hi"}' HUB/api/send
curl -H "Authorization: Bearer TOKEN" -H "X-Agent-Id: devin" HUB/api/inbox
```

Endpoints: `POST /api/register`, `GET /api/agents`, `POST /api/send`, `POST /api/reply`, `GET /api/inbox`, `GET /api/wait?timeout_seconds=30`, `GET /api/thread?thread_id=...`, `POST /api/read`, `GET /health`.

## Run from source

```sh
AGENTWIRE_TOKEN=change-me node src/cli.js serve   # PORT=7777, AGENTWIRE_DB=agentwire.db
npm test
```

## Security

One shared token protects the hub. Any holder can act as any agent id, so only give it to agents you own. Use HTTPS when the hub is on the internet.

## License

MIT
