#!/usr/bin/env bash
#
# deploy/smoke.sh — post-deploy health + readiness smoke check.
#
# ADR-0014 §7; docs/runbook/deploy.md "Health + smoke check (every deploy)".
#
# Curls the API's liveness and readiness probes through the PUBLIC origin and
# exits non-zero (with a clear message) the moment either fails, so a deploy can
# be gated on a healthy box. .github/workflows/deploy.yml runs this against the
# public domain after `docker compose up -d`; a human runs the exact same check
# by hand from the runbook.
#
# Contract (apps/api/src/modules/health/health.controller.ts):
#   GET /health        -> 200  {"ok":true}
#   GET /health/ready  -> 200  {"ok":true,"db":"up","redis":"up"}
#                         503  {"ok":false,...}   when DB or Redis is down
# `curl -fsS` turns the 503 (or any non-2xx / connection error) into a non-zero
# exit, which fails this script.
#
# Usage:
#   deploy/smoke.sh https://app.fleetco.example
#   SMOKE_BASE_URL=https://app.fleetco.example deploy/smoke.sh
#
# On-box fallback (per docs/runbook/deploy.md) when /health* is NOT publicly
# proxied — probe the api container directly instead of running this script:
#   docker compose -f docker-compose.prod.yml exec api \
#     node -e "fetch('http://127.0.0.1:3001/health/ready').then(r=>r.text()).then(console.log)"
# (the runbook shows a curl/wget form; the slim api image ships neither, so
# node's global fetch is the on-box tool — the same probe the compose
# healthcheck uses in docker-compose.prod.yml.)

set -euo pipefail

# --- resolve the base URL (arg 1, else $SMOKE_BASE_URL) ----------------------
BASE_URL="${1:-${SMOKE_BASE_URL:-}}"
if [ -z "${BASE_URL}" ]; then
  echo "smoke: no base URL. Pass it as the first argument or set SMOKE_BASE_URL." >&2
  echo "  usage: deploy/smoke.sh https://app.fleetco.example" >&2
  exit 2
fi
BASE_URL="${BASE_URL%/}" # drop one trailing slash so "<base>/health" stays clean

# curl flags: -f fail on non-2xx (a 503 readiness fails here), -s quiet, -S still
# print the error, --max-time cap a hung box. SMOKE_MAX_TIME tunes the per-probe
# timeout (seconds).
MAX_TIME="${SMOKE_MAX_TIME:-10}"

# RESP holds the most recent response body; http_get sets it.
RESP=""

http_get() {
  # GET "$BASE_URL$1" into the global RESP. Exit non-zero (with a clear message)
  # on a connection error or any non-2xx status.
  local url="${BASE_URL}$1"
  if ! RESP="$(curl -fsS --max-time "${MAX_TIME}" "${url}")"; then
    echo "smoke: FAIL — GET ${url} did not return 2xx (connection error, or non-2xx such as 503)." >&2
    exit 1
  fi
}

assert_match() {
  # assert_match <extended-regex> <human-description>; checks the global RESP.
  if ! printf '%s' "${RESP}" | grep -Eq "$1"; then
    echo "smoke: FAIL — $2." >&2
    echo "  response body: ${RESP}" >&2
    exit 1
  fi
}

echo "smoke: checking ${BASE_URL} ..."

# 1) Liveness — /health must be 200 {"ok":true}.
http_get "/health"
assert_match '"ok"[[:space:]]*:[[:space:]]*true' '/health did not report {"ok":true}'
echo "smoke: /health OK"

# 2) Readiness — /health/ready must be 200 with both datastores up.
http_get "/health/ready"
assert_match '"ok"[[:space:]]*:[[:space:]]*true' '/health/ready "ok" was not true'
assert_match '"db"[[:space:]]*:[[:space:]]*"up"' '/health/ready reported db not "up"'
assert_match '"redis"[[:space:]]*:[[:space:]]*"up"' '/health/ready reported redis not "up"'
echo "smoke: /health/ready OK (db up, redis up)"

echo "smoke: PASS — ${BASE_URL} is live and ready."
