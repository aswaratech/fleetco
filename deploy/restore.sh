#!/usr/bin/env bash
#
# deploy/restore.sh — fetch + decrypt + load-into-scratch-DB restore helper.
#
# ADR-0014 §6; docs/runbook/restore-from-backup.md "Restore procedure".
#
# Automates ONLY the safe, non-destructive half of a restore: it pulls a dated
# backup object from Cloudflare R2, age-decrypts + gunzips it, loads it into a
# SCRATCH database (default fleetco_restore), prints a row-count / admin-User
# sanity check, then STOPS. It NEVER drops or overwrites the live database — the
# Branch-A repoint vs Branch-B in-place cutover stays an explicit operator step
# (docs/runbook/restore-from-backup.md "Restore procedure" step 4). An untested
# backup does not exist (docs/runbook/README.md); this helper automates the
# fetch/decrypt/load side of the within-two-weeks-of-first-deploy restore drill.
#
# RUN ON THE BOX, from the FleetCo project dir. The script cd's to its own parent
# directory (e.g. /opt/fleetco) so `docker compose` finds the prod compose file
# and reads `.env` — for the `exec -T postgres` target and the compose file's own
# ${IMAGE_TAG}/${POSTGRES_*}/${PUBLIC_DOMAIN} interpolation (ADR-0014 §4).
#
# CONFIGURE via environment (NO secret is ever hardcoded — ADR-0013 / CLAUDE.md):
#   AGE_KEY      path to the age IDENTITY (private key) that decrypts the dump —
#                the single most catastrophic thing to lose; retrieved from the
#                on-box /opt/fleetco/secrets/age-identity.txt (chmod 600) or the
#                sealed envelope per business-continuity.md.
#   R2_REMOTE    the rclone remote name for R2 (e.g. r2)
#   R2_BUCKET    the R2 bucket name (<r2-bucket>)
#   DB_USER      the production Postgres role (= POSTGRES_USER in .env)
#   RESTORE_DB   scratch DB name (optional; default fleetco_restore; MUST end in
#                _restore — the live DB is never a valid target here)
#   COMPOSE_FILE     prod compose file (optional; default docker-compose.prod.yml)
#   RESTORE_TMPDIR   scratch dir for the fetched object + plaintext SQL
#                    (optional; default /tmp)
#
# USAGE:
#   deploy/restore.sh --list                            # list backup objects in R2
#   deploy/restore.sh fleetco-2026-05-29.sql.gz.age     # restore that object to the scratch DB
#   BACKUP_OBJECT=fleetco-2026-05-29.sql.gz.age deploy/restore.sh

set -euo pipefail

# --- locate the project dir + load optional operator config ------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "${SCRIPT_DIR}")"

# Optional: source the same gitignored deploy/backup.env the backup script reads
# (see .gitignore) so cron / a fresh shell has one place for the operator config.
RESTORE_ENV_FILE="${RESTORE_ENV_FILE:-${SCRIPT_DIR}/backup.env}"
if [ -f "${RESTORE_ENV_FILE}" ]; then
  # shellcheck source=/dev/null
  . "${RESTORE_ENV_FILE}"
fi

cd "${PROJECT_DIR}" || {
  echo "restore: FAIL — cannot cd to project dir ${PROJECT_DIR}" >&2
  exit 1
}

COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.prod.yml}"
RESTORE_TMPDIR="${RESTORE_TMPDIR:-/tmp}"
RESTORE_DB="${RESTORE_DB:-fleetco_restore}"

# Required for every mode that talks to R2 (incl. --list).
: "${R2_REMOTE:?set R2_REMOTE (the rclone remote name for Cloudflare R2, e.g. r2)}"
: "${R2_BUCKET:?set R2_BUCKET (the R2 bucket name)}"

# --- --list mode: just enumerate the bucket and exit -------------------------
# SCOPED to backup objects by name (`--include "/fleetco-*.sql.gz.age"`,
# anchored to the bucket root): the same R2 bucket also holds the app's object
# store under the `invoices/`/`documents/`/`agent-attachments/` prefixes
# (ADR-0014 §6 shared-bucket annotation), so an unfiltered `lsf` would list
# those prefixes among the backups. The object FETCH below is by exact name and
# is unaffected — only this human-facing listing is filtered.
if [ "${1:-}" = "--list" ]; then
  echo "restore: backups in ${R2_REMOTE}:${R2_BUCKET}/ —"
  rclone lsf --include "/fleetco-*.sql.gz.age" "${R2_REMOTE}:${R2_BUCKET}/"
  exit 0
fi

# --- resolve which object to restore (arg 1, else $BACKUP_OBJECT) ------------
OBJECT="${1:-${BACKUP_OBJECT:-}}"
if [ -z "${OBJECT}" ]; then
  echo "restore: no backup object. Pass it as arg 1 or set BACKUP_OBJECT." >&2
  echo "  list available: deploy/restore.sh --list" >&2
  echo "  usage:          deploy/restore.sh fleetco-YYYY-MM-DD.sql.gz.age" >&2
  exit 2
fi

# --- refuse to ever target the live database ---------------------------------
# This helper is non-destructive by construction: it only ever (re)creates and
# writes a scratch DB whose name ends in _restore. Refuse anything else so it can
# never be pointed at production — the in-place cutover is Branch B in the
# runbook, done by hand and deliberately.
case "${RESTORE_DB}" in
  *_restore) : ;;
  *)
    echo "restore: REFUSING — RESTORE_DB='${RESTORE_DB}' is not a scratch DB (must end in _restore)." >&2
    echo "  This helper never writes the live database. Do the in-place cutover by hand —" >&2
    echo "  docs/runbook/restore-from-backup.md 'Restore procedure' step 4, Branch B." >&2
    exit 2
    ;;
esac

: "${AGE_KEY:?set AGE_KEY (path to the age identity/private key that decrypts the dump)}"
: "${DB_USER:?set DB_USER (the production Postgres role; = POSTGRES_USER in .env)}"

if [ ! -f "${AGE_KEY}" ]; then
  echo "restore: FAIL — AGE_KEY '${AGE_KEY}' is not a readable file." >&2
  echo "  Retrieve the age identity per docs/runbook/business-continuity.md." >&2
  exit 1
fi

# --- scratch workspace (the decrypted SQL is PLAINTEXT prod data) ------------
workdir="$(mktemp -d "${RESTORE_TMPDIR%/}/fleetco-restore.XXXXXX")"
# Remove the whole workdir on exit so the plaintext dump never lingers.
trap 'rm -rf "${workdir}"' EXIT

echo "restore: fetching ${OBJECT} from ${R2_REMOTE}:${R2_BUCKET}/ ..."
rclone copy "${R2_REMOTE}:${R2_BUCKET}/${OBJECT}" "${workdir}/"

encrypted="${workdir}/${OBJECT}"
if [ ! -s "${encrypted}" ]; then
  echo "restore: FAIL — fetched object ${encrypted} is missing or empty." >&2
  echo "  Check the name with: deploy/restore.sh --list" >&2
  exit 1
fi

restore_sql="${workdir}/restore.sql"
echo "restore: decrypting + decompressing -> restore.sql ..."
# pipefail makes a wrong/lost key or a truncated object fail here, before we load
# anything, instead of silently loading junk into the scratch DB.
age -d -i "${AGE_KEY}" "${encrypted}" | gunzip >"${restore_sql}"

echo "restore: (re)creating scratch DB ${RESTORE_DB} and loading the dump ..."
# Safe: RESTORE_DB is guarded above to end in _restore, so this drop/create can
# never hit production. --if-exists makes the helper re-runnable. The dump's
# --clean --if-exists then rebuilds the schema + data into the fresh scratch DB.
docker compose -f "${COMPOSE_FILE}" exec -T postgres dropdb -U "${DB_USER}" --if-exists "${RESTORE_DB}"
docker compose -f "${COMPOSE_FILE}" exec -T postgres createdb -U "${DB_USER}" "${RESTORE_DB}"
docker compose -f "${COMPOSE_FILE}" exec -T postgres psql -U "${DB_USER}" -d "${RESTORE_DB}" <"${restore_sql}"

echo "restore: sanity check on ${RESTORE_DB} (row counts + admin user) —"
# Wrapped in `if` so a missing-table error (empty/bad dump) surfaces as a clear
# warning rather than aborting before the cutover guidance below prints.
# Table names are the Prisma @@map names (snake_case: vehicle, trip, fuel_log,
# expense_log, user — see apps/api/prisma/schema.prisma), NOT the PascalCase
# model names. The original PascalCase queries could never match a real dump —
# every sanity query failed against a correctly-restored database (caught by
# the 2026-07-10 local restore drill). "user" stays quoted: reserved word.
if ! docker compose -f "${COMPOSE_FILE}" exec -T postgres \
  psql -U "${DB_USER}" -d "${RESTORE_DB}" \
  -c 'SELECT count(*) AS vehicles FROM "vehicle";' \
  -c 'SELECT count(*) AS trips FROM "trip";' \
  -c 'SELECT count(*) AS fuel_logs FROM "fuel_log";' \
  -c 'SELECT count(*) AS expense_logs FROM "expense_log";' \
  -c 'SELECT count(*) AS users FROM "user";'; then
  echo "restore: WARNING — sanity-check query failed (tables missing? empty dump?). Inspect ${RESTORE_DB} by hand." >&2
fi

cat <<EOF
restore: DONE — the dump is loaded into the scratch DB '${RESTORE_DB}' and sanity-checked.
This helper STOPS here; it has NOT touched the live database.
Cut over by hand per docs/runbook/restore-from-backup.md "Restore procedure" step 4:
  - Branch A (preferred, non-destructive): point DATABASE_URL in /opt/fleetco/.env
    at '${RESTORE_DB}', then: docker compose -f ${COMPOSE_FILE} up -d api web
  - Branch B (in-place, destructive): only after Branch A's sanity check passes.
EOF
