#!/usr/bin/env bash
# Seed the agent directory from the mounted config on every start (config wins),
# then run pi web bound to all interfaces with the required token.
set -euo pipefail
: "${PI_WEB_TOKEN:?PI_WEB_TOKEN must be set (see .env.example)}"
mkdir -p /data/agent /workspace/.pi
cp /config/settings.json /workspace/.pi/settings.json
if [[ -f /config/models.json ]]; then cp /config/models.json /data/agent/models.json; fi
# Wait until mcp-js answers; the coordinator connect fails fast otherwise.
url="${MCP_JS_URL:-http://mcp-js:3000}"
for _ in $(seq 1 60); do
  if node -e "fetch(process.argv[1]+'/api/capabilities').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))" "$url"; then break; fi
  echo "waiting for mcp-js at $url"; sleep 2
done
exec /app/pi-test.sh web --host 0.0.0.0 --port 8600 --token "$PI_WEB_TOKEN" "$@"
