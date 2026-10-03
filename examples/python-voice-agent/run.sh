#!/usr/bin/env bash
# Starts the gateway and the mock MFA backend, plays the call, stops everything.
#   ./run.sh          the real supplier
#   ./run.sh --scam   an impostor
set -euo pipefail
cd "$(dirname "$0")"
PY=${PY:-../../clients/python/.venv/bin/python}
[ -x "$PY" ] || { echo "install the Python client first: cd ../../clients/python && uv venv && uv pip install -e ."; exit 1; }
DB=$(mktemp -t anticlus-py).db
ANTICLUS_DB="$DB" ANTICLUS_COUNTERPARTIES=../counterparties.json ANTICLUS_POLICIES=../policies.json \
ANTICLUS_AGENT_KEY=demo-agent-key ANTICLUS_TOOL_KEY=demo-tool-key ANTICLUS_ADMIN_KEY=demo-admin-key \
ANTICLUS_MFA_SECRET=demo-mfa-secret ANTICLUS_MFA_WEBHOOK_URL=http://127.0.0.1:8788/mfa PORT=8787 \
  node --import tsx ../../src/cli.ts >/dev/null 2>&1 &
GW=$!
if [[ "${1:-}" == "--scam" ]]; then "$PY" mfa_backend.py --refuse & else "$PY" mfa_backend.py & fi
MFA=$!
trap 'kill $GW $MFA 2>/dev/null; rm -f "$DB" "$DB-wal" "$DB-shm"' EXIT
for _ in $(seq 1 60); do curl -sf http://127.0.0.1:8787/healthz >/dev/null 2>&1 && break; sleep 0.3; done
curl -sf http://127.0.0.1:8787/healthz >/dev/null || { echo "the gateway did not start (is port 8787 free?)"; exit 1; }
"$PY" agent.py "${1:-}"
