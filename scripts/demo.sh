#!/usr/bin/env bash
# Boots the whole live demo: server (verifier/indexer/API), web board, builder agent, finder agent.
# Logs go to .demo/logs/*.log and are tailed here with a prefix. Ctrl-C stops everything.
#
#   scripts/demo.sh           start everything
#   scripts/demo.sh stop      stop everything
#   scripts/demo.sh reset     clear consoles, agent state and patched manifests (run before recording)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LOGS="$ROOT/.demo/logs"; PIDS="$ROOT/.demo/pids"
mkdir -p "$LOGS" "$PIDS"

stop() {
  for f in "$PIDS"/*.pid; do [ -f "$f" ] || continue; kill "$(cat "$f")" 2>/dev/null || true; rm -f "$f"; done
  pkill -f "bun --watch src/index.ts" 2>/dev/null || true
  pkill -f "next dev" 2>/dev/null || true
  pkill -f "cloudflared tunnel" 2>/dev/null || true
  echo "stopped"
}

reset() {
  set -a; . "$ROOT/.env"; set +a
  echo "clearing agent_logs…"
  curl -s -X DELETE "$SUPABASE_URL/rest/v1/agent_logs?id=gt.0" -H "apikey: $SUPABASE_SECRET_KEY" -H "Authorization: Bearer $SUPABASE_SECRET_KEY" -o /dev/null
  rm -rf "$ROOT/apps/agents/.state" "$ROOT/apps/agents/redteam"/finding-*.json
  find "$ROOT/apps/agents/manifests/targets" -name '*-v[0-9]*.json' -delete
  echo "reset done (agent state, findings, patched manifests, consoles)"
}

start() {
  set -a; . "$ROOT/.env"; set +a
  run() { # name, dir, cmd...
    local name=$1 dir=$2; shift 2
    ( cd "$dir" && exec "$@" ) >"$LOGS/$name.log" 2>&1 &
    echo $! >"$PIDS/$name.pid"
    echo "[$name] pid $! → $LOGS/$name.log"
  }
  run server "$ROOT/apps/server" bun --watch src/index.ts
  run web    "$ROOT/apps/web"    pnpm exec next dev -p 3000
  echo "waiting for server…"; for i in $(seq 1 30); do curl -sf localhost:8787/health >/dev/null && break; sleep 1; done
  if [ "${DEMO_TUNNEL:-0}" = "1" ] && command -v cloudflared >/dev/null; then
    run tunnel "$ROOT" cloudflared tunnel --url http://localhost:8787
    for i in $(seq 1 20); do URL=$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$LOGS/tunnel.log" | grep -v '^https://api\.' | head -1 || true); [ -n "$URL" ] && break; sleep 1; done
    if [ -n "${URL:-}" ]; then
      echo "$URL" > "$ROOT/.demo/tunnel.url"
      echo "public server url: $URL   (share with external agents as SERVER_URL)"
      # Publish it so the public board (Vercel) can find the verifier API at runtime.
      curl -s -X POST "$SUPABASE_URL/rest/v1/meta" -H "apikey: $SUPABASE_SECRET_KEY" -H "Authorization: Bearer $SUPABASE_SECRET_KEY" \
        -H "content-type: application/json" -H "Prefer: resolution=merge-duplicates" -d "{\"key\":\"serverUrl\",\"value\":\"$URL\"}" -o /dev/null || true
    else
      echo "tunnel: no URL yet (Cloudflare quick-tunnel API slow); external agents can use it once $LOGS/tunnel.log shows one"
    fi
  fi
  run builder "$ROOT/apps/agents" bun run src/buyer-agent.ts --interval "${BUILDER_INTERVAL:-20}"
  sleep 8   # let the builder post before the finder scans
  # FINDER_ARGS e.g. "--bounty 6,9" to focus the recording on specific bounties
  run finder  "$ROOT/apps/agents" bun run src/seller-agent.ts --interval "${FINDER_INTERVAL:-20}" --max-turns "${FINDER_TURNS:-6}" ${FINDER_ARGS:-}
  echo
  echo "board    http://localhost:3000"
  echo "deployer http://localhost:3000/northwind"
  echo "server   http://localhost:8787/health"
  echo
  trap 'stop; exit 0' INT TERM
  tail -n +1 -F "$LOGS/builder.log" "$LOGS/finder.log" "$LOGS/server.log" 2>/dev/null | sed -u \
    -e 's|^==> .*/builder.log <==|--- builder ---|' -e 's|^==> .*/finder.log <==|--- finder ---|' -e 's|^==> .*/server.log <==|--- server ---|'
}

case "${1:-start}" in
  start) start ;;
  stop) stop ;;
  reset) reset ;;
  *) echo "usage: $0 [start|stop|reset]"; exit 1 ;;
esac
