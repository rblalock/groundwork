#!/usr/bin/env bash
# A public HTTPS URL for Photon's webhook while the agent runs on this machine. Starts a Cloudflare
# quick tunnel (no account) in front of a proxy that forwards only POST /eve/v1/photon, because
# `eve dev` lets any caller chat as the owner. Both run detached, so the URL stays the same until
# you stop them or reboot, however often the agent restarts.
#
#   scripts/photon-tunnel.sh up      start the proxy and tunnel, print the webhook URL (safe to rerun)
#   scripts/photon-tunnel.sh url     print the webhook URL
#   scripts/photon-tunnel.sh down    stop both
#
# Run the agent with `npm run dev:photon` (port 4311). Set the printed URL as the webhook in
# Photon and its signing secret as IMESSAGE_WEBHOOK_SECRET in .env.local.
set -euo pipefail

cd "$(dirname "$0")/.."
STATE=.local-tunnel
PROXY_PORT=${PROXY_PORT:-4310}
AGENT_PORT=${AGENT_PORT:-4311}
mkdir -p "$STATE"

alive() { [[ -f "$STATE/$1.pid" ]] && kill -0 "$(cat "$STATE/$1.pid")" 2>/dev/null; }
detach() { # name, command...
  local name=$1; shift
  if command -v setsid >/dev/null; then setsid nohup "$@" >"$STATE/$name.log" 2>&1 </dev/null &
  else nohup "$@" >"$STATE/$name.log" 2>&1 </dev/null &
  fi
  echo $! >"$STATE/$name.pid"
}
url() { grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$STATE/tunnel.log" 2>/dev/null | head -1; }

cloudflared_bin() {
  if command -v cloudflared >/dev/null; then command -v cloudflared; return; fi
  local bin=$STATE/cloudflared
  if [[ ! -x $bin ]]; then
    local os arch
    os=$(uname -s | tr '[:upper:]' '[:lower:]'); arch=$(uname -m)
    [[ $arch == x86_64 ]] && arch=amd64; [[ $arch == aarch64 ]] && arch=arm64
    [[ $os == linux ]] || { echo "error: install cloudflared (brew install cloudflared)" >&2; exit 1; }
    curl -fsSL -o "$bin" "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-$arch"
    chmod +x "$bin"
  fi
  echo "$bin"
}

case ${1:-} in
  up)
    alive proxy || detach proxy node scripts/webhook-proxy.mjs "$PROXY_PORT" "$AGENT_PORT"
    if ! alive tunnel; then
      detach tunnel "$(cloudflared_bin)" tunnel --no-autoupdate --url "http://localhost:$PROXY_PORT"
      for _ in $(seq 1 30); do [[ -n $(url) ]] && break; sleep 1; done
    fi
    [[ -n $(url) ]] || { echo "error: no tunnel URL yet, see $STATE/tunnel.log" >&2; exit 1; }
    echo "$(url)/eve/v1/photon"
    ;;
  url)
    alive tunnel && [[ -n $(url) ]] || { echo "error: not running, use: $0 up" >&2; exit 1; }
    echo "$(url)/eve/v1/photon"
    ;;
  down)
    for name in tunnel proxy; do
      alive "$name" && kill "$(cat "$STATE/$name.pid")"
      rm -f "$STATE/$name.pid"
    done
    ;;
  *)
    echo "usage: $0 up|url|down" >&2
    exit 1
    ;;
esac
