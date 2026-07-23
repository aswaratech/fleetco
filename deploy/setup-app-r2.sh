#!/usr/bin/env bash
#
# setup-app-r2.sh — activate the app's R2 object store on the production box.
#
# The API binds its REAL Cloudflare R2 store (invoice PDFs, fleet documents —
# ADR-0049, agent attachments) only when all four R2_* vars are set in
# /opt/fleetco/.env; while any is blank it runs the in-memory MockObjectStorage
# (bytes vanish on restart, invoice issue() 422s). This script collects the four
# values interactively, writes them into .env idempotently, recreates the api
# container, and points at the verification — so activation is one command
# instead of a hand-edit.
#
# SHARED BUCKET (ADR-0014 §6 annotation): R2_BUCKET is the SAME bucket the
# nightly backup uses (fleetco-backups). The app writes only under the
# invoices/ , documents/ , agent-attachments/ key PREFIXES; the backup's 30-day
# prune is filename-scoped (deploy/backup.sh) so it never touches them.
#
# SECURITY: the R2 SECRET access key is a Tier-1 credential (ADR-0013). It is
# read with a SILENT prompt (no echo), never printed, never placed on a command
# line (so it cannot leak into `ps` / shell history), and written to a
# root-owned, chmod-600 .env via a umask-077 temp file. Get it from Cloudflare
# (R2 -> Manage R2 API Tokens -> Object Read & Write, scoped to the bucket) or
# reuse the S3 credentials your backup already uses.
#
#   Usage (ON THE BOX, as root so it can read/write the 600 .env):
#     sudo bash /opt/fleetco/deploy/setup-app-r2.sh
#
#   Overrides (optional): ENV_FILE, COMPOSE_FILE, and R2_NO_RESTART=1 to write
#   the .env but skip recreating the api container (recreate it yourself later).

set -euo pipefail

# --- locate the project dir + the runtime .env -------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "${SCRIPT_DIR}")"
ENV_FILE="${ENV_FILE:-${PROJECT_DIR}/.env}"
COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.prod.yml}"

cd "${PROJECT_DIR}" || {
  echo "setup-app-r2: FAIL — cannot cd to project dir ${PROJECT_DIR}" >&2
  exit 1
}

# --- preconditions -----------------------------------------------------------
if [ ! -f "${ENV_FILE}" ]; then
  echo "setup-app-r2: FAIL — ${ENV_FILE} not found. Run this on the deployed box." >&2
  exit 1
fi
if [ ! -w "${ENV_FILE}" ]; then
  echo "setup-app-r2: FAIL — ${ENV_FILE} is not writable; re-run with sudo." >&2
  exit 1
fi
command -v docker >/dev/null 2>&1 || {
  echo "setup-app-r2: FAIL — docker not found on PATH." >&2
  exit 1
}

echo "setup-app-r2: activating the app R2 object store in ${ENV_FILE}."
echo "  (the app shares the backup bucket; see ADR-0014 §6 shared-bucket annotation)"
echo

# --- collect the four values -------------------------------------------------
# Endpoint (visible): the S3 API endpoint, no bucket in the path.
read -r -p "R2_ENDPOINT  (https://<account-id>.r2.cloudflarestorage.com): " R2_ENDPOINT
case "${R2_ENDPOINT}" in
  https://*) : ;;
  *) echo "setup-app-r2: FAIL — R2_ENDPOINT must start with https://" >&2; exit 1 ;;
esac

# Access key id (visible — it identifies the token, like a username).
read -r -p "R2_ACCESS_KEY_ID: " R2_ACCESS_KEY_ID
[ -n "${R2_ACCESS_KEY_ID}" ] || { echo "setup-app-r2: FAIL — R2_ACCESS_KEY_ID is empty." >&2; exit 1; }

# Secret access key (SILENT — the Tier-1 credential; never echoed).
read -r -s -p "R2_SECRET_ACCESS_KEY (input hidden): " R2_SECRET_ACCESS_KEY
echo
[ -n "${R2_SECRET_ACCESS_KEY}" ] || { echo "setup-app-r2: FAIL — R2_SECRET_ACCESS_KEY is empty." >&2; exit 1; }

# Bucket (visible; default to the shared backup bucket).
read -r -p "R2_BUCKET [fleetco-backups]: " R2_BUCKET
R2_BUCKET="${R2_BUCKET:-fleetco-backups}"

# --- confirm (never showing the secret) --------------------------------------
echo
echo "About to write these to ${ENV_FILE} and recreate the api container:"
echo "  R2_ENDPOINT      = ${R2_ENDPOINT}"
echo "  R2_ACCESS_KEY_ID = ${R2_ACCESS_KEY_ID}"
echo "  R2_SECRET_ACCESS_KEY = (hidden — ${#R2_SECRET_ACCESS_KEY} chars)"
echo "  R2_BUCKET        = ${R2_BUCKET}"
read -r -p "Proceed? [y/N]: " confirm
case "${confirm}" in
  y | Y | yes | YES) : ;;
  *) echo "setup-app-r2: aborted; nothing written."; exit 0 ;;
esac

# --- back up the current .env, then upsert the four keys ---------------------
backup="${ENV_FILE}.bak.$(date -u +%Y%m%dT%H%M%SZ)"
cp -p "${ENV_FILE}" "${backup}"
echo "setup-app-r2: backed up ${ENV_FILE} -> ${backup}"

# Build the new file: keep every line EXCEPT the four keys we manage, then
# append the fresh values. printf writes the values LITERALLY, so a secret
# containing sed-special characters (/, +, =) can never corrupt the file or be
# reinterpreted — the reason this uses grep+printf, not sed -i. umask 077 makes
# the temp 600 from creation, so the secret is never briefly world-readable.
umask 077
tmp="$(mktemp "${ENV_FILE}.XXXXXX")"
trap 'rm -f "${tmp}"' EXIT
grep -vE '^(R2_ENDPOINT|R2_ACCESS_KEY_ID|R2_SECRET_ACCESS_KEY|R2_BUCKET)=' "${ENV_FILE}" >"${tmp}" || true
{
  printf 'R2_ENDPOINT=%s\n' "${R2_ENDPOINT}"
  printf 'R2_ACCESS_KEY_ID=%s\n' "${R2_ACCESS_KEY_ID}"
  printf 'R2_SECRET_ACCESS_KEY=%s\n' "${R2_SECRET_ACCESS_KEY}"
  printf 'R2_BUCKET=%s\n' "${R2_BUCKET}"
} >>"${tmp}"
mv "${tmp}" "${ENV_FILE}"
trap - EXIT
chmod 600 "${ENV_FILE}"
echo "setup-app-r2: wrote the four R2_* vars to ${ENV_FILE} (mode 600)."

# --- recreate the api container (unless told not to) -------------------------
if [ "${R2_NO_RESTART:-0}" = "1" ]; then
  echo "setup-app-r2: R2_NO_RESTART=1 — skipping the api recreate. Run this when ready:"
  echo "    docker compose -f ${COMPOSE_FILE} up -d api"
else
  echo "setup-app-r2: recreating the api container (postgres/redis/web untouched)..."
  docker compose -f "${COMPOSE_FILE}" up -d api
fi

# --- verification pointers (the definitive check is a real upload) -----------
cat <<'EOF'

setup-app-r2: PASS — the four R2_* vars are set and the api was recreated.

VERIFY it is real R2, not the mock (do this now):
  1. In the web app, upload a document on any vehicle/driver/customer, then
     click Open — it should stream back.
  2. Confirm the object landed in R2 (uses your working backup remote):
       rclone lsf r2:<bucket>/documents/
  3. Recreate the api once more and re-open the document — if it STILL streams,
     it is genuinely persisted to R2 (the mock would have lost it on restart):
       docker compose -f docker-compose.prod.yml up -d api

THEN (the ADR-0014 §6 shared-bucket follow-up): run one backup and confirm a
fresh fleetco-<date>.sql.gz.age lands AND your uploaded document is still there
afterward — proving the scoped prune leaves app objects alone:
    bash deploy/backup.sh

NOTE: invoice ISSUE additionally needs INVOICE_SUPPLIER_PAN in the same .env
(documents and attachments do not). Set it if you plan to issue invoices.
EOF
