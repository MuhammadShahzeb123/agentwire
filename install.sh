#!/bin/sh
# AgentWire one-line installer: curl -fsSL https://raw.githubusercontent.com/MuhammadShahzeb123/agentwire/main/install.sh | sh
set -e
DIR="${AGENTWIRE_HOME:-$HOME/.agentwire}"
PORT="${PORT:-7777}"
REPO="https://github.com/MuhammadShahzeb123/agentwire"
mkdir -p "$DIR"
if [ -f "$DIR/token" ]; then TOKEN=$(cat "$DIR/token"); else
  TOKEN=$(head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n'); echo "$TOKEN" > "$DIR/token"; chmod 600 "$DIR/token"; fi

node_ok() { command -v node >/dev/null 2>&1 && node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a==22&&b>=5)?0:1)'; }

if node_ok; then
  if command -v git >/dev/null 2>&1; then
    [ -d "$DIR/app/.git" ] && git -C "$DIR/app" pull -q || git clone -q --depth 1 "$REPO" "$DIR/app"
  else
    rm -rf "$DIR/app"; mkdir -p "$DIR/app"; curl -fsSL "$REPO/archive/refs/heads/main.tar.gz" | tar xz -C "$DIR/app" --strip-components=1
  fi
  if command -v systemctl >/dev/null 2>&1 && systemctl --user status >/dev/null 2>&1; then
    mkdir -p "$HOME/.config/systemd/user"
    cat > "$HOME/.config/systemd/user/agentwire.service" <<UNIT
[Unit]
Description=AgentWire hub
[Service]
Environment=PORT=$PORT AGENTWIRE_TOKEN=$TOKEN AGENTWIRE_DB=$DIR/agentwire.db
ExecStart=$(command -v node) $DIR/app/src/cli.js serve
Restart=always
[Install]
WantedBy=default.target
UNIT
    systemctl --user daemon-reload; systemctl --user enable --now agentwire
    command -v loginctl >/dev/null 2>&1 && loginctl enable-linger "$(id -un)" 2>/dev/null || true
  else
    PORT=$PORT AGENTWIRE_TOKEN=$TOKEN AGENTWIRE_DB="$DIR/agentwire.db" nohup node "$DIR/app/src/cli.js" serve > "$DIR/hub.log" 2>&1 &
  fi
elif command -v docker >/dev/null 2>&1; then
  docker rm -f agentwire >/dev/null 2>&1 || true
  docker run -d --name agentwire --restart unless-stopped -p "$PORT:7777" -e AGENTWIRE_TOKEN="$TOKEN" -v agentwire-data:/data ghcr.io/muhammadshahzeb123/agentwire:latest 2>/dev/null || {
    rm -rf "$DIR/app"; mkdir -p "$DIR/app"; curl -fsSL "$REPO/archive/refs/heads/main.tar.gz" | tar xz -C "$DIR/app" --strip-components=1
    docker build -q -t agentwire "$DIR/app" && docker run -d --name agentwire --restart unless-stopped -p "$PORT:7777" -e AGENTWIRE_TOKEN="$TOKEN" -v agentwire-data:/data agentwire; }
else
  echo "AgentWire needs Node.js 22.5+ (https://nodejs.org) or Docker. Install one and rerun."; exit 1
fi
echo ""
echo "AgentWire hub is running on port $PORT"
echo "Token:   $TOKEN   (saved in $DIR/token)"
echo "MCP URL: http://<this-host>:$PORT/mcp?agent=<agent-id>&token=$TOKEN"
echo "See README for Codex, Claude Code, Devin and Grok Bot setup."
