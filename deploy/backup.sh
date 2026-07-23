#!/usr/bin/env bash
#
# deploy/backup.sh — nightly encrypted, offsite Postgres backup.
#
# ADR-0014 §6; docs/runbook/restore-from-backup.md "Backup (the create side)".
#
# Dumps the production database, gzips and age-encrypts it in ONE pipe (so no
# plaintext dump ever lands on disk), uploads the dated object to Cloudflare R2
# via rclone, then prunes copies older than 30 days — the daily pg_dump | gzip |
# age | R2 with 30-day retention ADR-0014 §6 commits to (satisfying RPO 24 h).
# The matching restore side is docs/runbook/restore-from-backup.md / deploy/restore.sh.
#
# RUN ON THE BOX, from the FleetCo project dir. The script cd's to its own parent
# directory (e.g. /opt/fleetco) so `docker compose` finds the prod compose file
# and reads `.env` — both for the `exec -T postgres` target and for the compose
# file's own ${IMAGE_TAG}/${POSTGRES_*}/${PUBLIC_DOMAIN} interpolation (ADR-0014 §4).
#
# CONFIGURE via environment (NO secret is ever hardcoded — ADR-0013 / CLAUDE.md):
#   DB_USER        the production Postgres role        (= POSTGRES_USER in .env)
#   DB_NAME        the production Postgres database     (= POSTGRES_DB   in .env)
#   AGE_RECIPIENT  the age PUBLIC key to encrypt the dump TO (<age-recipient>).
#                  The matching private identity decrypts at restore time and
#                  lives per business-continuity.md — NEVER on the backup path.
#   R2_REMOTE      the rclone remote name for R2 (e.g. r2)
#   R2_BUCKET      the R2 bucket name (<r2-bucket>)
#   COMPOSE_FILE   prod compose file   (optional; default docker-compose.prod.yml)
#   BACKUP_TMPDIR  scratch dir for the temp object (optional; default /tmp)
#
# Cron has a minimal environment, so define the vars in a root-owned, chmod 600,
# gitignored `deploy/backup.env` (sourced automatically below — the same file
# deploy/restore.sh reads) or inline them on the crontab line. Install the
# nightly job (NPT is UTC+5:45, so 18:15 UTC ≈ 00:00 Nepal time):
#
#   15 18 * * * /opt/fleetco/deploy/backup.sh >> /opt/fleetco/backup.log 2>&1
#
# Verify the morning after the first run that a new fleetco-<date>.sql.gz.age
# landed in the bucket and is non-empty — an untested backup does not exist
# (docs/runbook/README.md).

set -euo pipefail

# --- locate the project dir + load optional operator config ------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "${SCRIPT_DIR}")"

# Optional: source a gitignored deploy/backup.env so cron (which has a minimal
# environment) has one place to define the vars below without inlining secrets
# into the crontab. Never commit this file (see .gitignore).
BACKUP_ENV_FILE="${BACKUP_ENV_FILE:-${SCRIPT_DIR}/backup.env}"
if [ -f "${BACKUP_ENV_FILE}" ]; then
  # shellcheck source=/dev/null
  . "${BACKUP_ENV_FILE}"
fi

cd "${PROJECT_DIR}" || {
  echo "backup: FAIL — cannot cd to project dir ${PROJECT_DIR}" >&2
  exit 1
}

# --- required operator config (no defaults; :? fails fast if unset/empty) -----
: "${DB_USER:?set DB_USER (the production Postgres role; = POSTGRES_USER in .env)}"
: "${DB_NAME:?set DB_NAME (the production Postgres database; = POSTGRES_DB in .env)}"
: "${AGE_RECIPIENT:?set AGE_RECIPIENT (the age PUBLIC key to encrypt the dump to)}"
: "${R2_REMOTE:?set R2_REMOTE (the rclone remote name for Cloudflare R2, e.g. r2)}"
: "${R2_BUCKET:?set R2_BUCKET (the R2 bucket name)}"

COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.prod.yml}"
BACKUP_TMPDIR="${BACKUP_TMPDIR:-/tmp}"

# --- scratch workspace (cleaned up no matter how we exit) --------------------
workdir="$(mktemp -d "${BACKUP_TMPDIR%/}/fleetco-backup.XXXXXX")"
trap 'rm -rf "${workdir}"' EXIT

object="fleetco-$(date -u +%F).sql.gz.age"
tmpfile="${workdir}/${object}"

echo "backup: dumping ${DB_NAME} -> gzip -> age -> ${object} ..."

# Dump → compress → encrypt in ONE pipe so no plaintext dump ever hits disk.
# `set -o pipefail` is load-bearing here: a pg_dump failure mid-pipe fails the
# whole script (and the trap removes the partial file) instead of shipping a
# truncated .age. `exec -T postgres` runs pg_dump inside the live postgres
# container (mirrors docker-compose.prod.yml); -T disables TTY for the pipe.
docker compose -f "${COMPOSE_FILE}" exec -T postgres \
  pg_dump -U "${DB_USER}" -d "${DB_NAME}" --no-owner --clean --if-exists \
  | gzip \
  | age -r "${AGE_RECIPIENT}" \
  >"${tmpfile}"

# Belt-and-suspenders: never upload a 0-byte object.
if [ ! -s "${tmpfile}" ]; then
  echo "backup: FAIL — encrypted dump ${tmpfile} is empty; not uploading." >&2
  exit 1
fi

echo "backup: uploading ${object} -> ${R2_REMOTE}:${R2_BUCKET}/ ..."
# rclone copy preserves the basename, so the object lands as ${object}.
# (aws-cli against the R2 S3 endpoint is the documented alternative — see
# docs/runbook/restore-from-backup.md.)
rclone copy "${tmpfile}" "${R2_REMOTE}:${R2_BUCKET}/"

# --- the Traccar gateway database (ADR-0042 c3) -------------------------------
# The gateway keeps its own decoded-position store in the separate `traccar`
# database of the same postgres container; ADR-0042 c3 extends this nightly
# dump to it. Same pipe discipline, distinct object name. The database is
# created manually per docs/runbook/traccar.md and may legitimately not exist
# yet (the first deploy precedes the gateway bring-up), so its absence SKIPS
# with a loud note rather than failing the main backup — once created, the
# dump self-activates on the next run.
traccar_exists="$(docker compose -f "${COMPOSE_FILE}" exec -T postgres \
  psql -U "${DB_USER}" -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname = 'traccar'")"
if [ "${traccar_exists}" = "1" ]; then
  traccar_object="fleetco-traccar-$(date -u +%F).sql.gz.age"
  traccar_tmpfile="${workdir}/${traccar_object}"

  echo "backup: dumping traccar -> gzip -> age -> ${traccar_object} ..."
  docker compose -f "${COMPOSE_FILE}" exec -T postgres \
    pg_dump -U "${DB_USER}" -d traccar --no-owner --clean --if-exists \
    | gzip \
    | age -r "${AGE_RECIPIENT}" \
    >"${traccar_tmpfile}"

  if [ ! -s "${traccar_tmpfile}" ]; then
    echo "backup: FAIL — encrypted traccar dump ${traccar_tmpfile} is empty; not uploading." >&2
    exit 1
  fi

  echo "backup: uploading ${traccar_object} -> ${R2_REMOTE}:${R2_BUCKET}/ ..."
  rclone copy "${traccar_tmpfile}" "${R2_REMOTE}:${R2_BUCKET}/"
else
  echo "backup: NOTE — traccar database not present; skipping its dump (one-time creation: docs/runbook/traccar.md)."
fi

# Prune backups older than 30 days (ADR-0014 §6 retention). SCOPED to the
# backup objects by name — the `--include "/fleetco-*.sql.gz.age"` filter
# (anchored to the bucket root with the leading slash) matches ONLY the daily
# dumps this script writes (`fleetco-<date>.sql.gz.age` and
# `fleetco-traccar-<date>.sql.gz.age`). This is LOAD-BEARING: the same R2
# bucket also holds the app's object store (invoice PDFs, fleet documents,
# agent attachments — ADR-0014 §6 shared-bucket annotation), which live under
# the `invoices/`, `documents/`, and `agent-attachments/` PREFIXES and must
# NEVER be pruned (fleet documents have entity lifetimes — ADR-0049 c8; an
# issued invoice PDF is a permanent legal record). Without the filter, this
# recursive delete would silently destroy every app object older than 30 days.
# NOTE: if a NEW backup object name is ever added that does not match
# `fleetco-*.sql.gz.age`, extend this filter to cover it.
echo "backup: pruning ${R2_REMOTE}:${R2_BUCKET}/ backups older than 30d ..."
rclone delete --min-age 30d --include "/fleetco-*.sql.gz.age" "${R2_REMOTE}:${R2_BUCKET}/"

echo "backup: PASS — ${object} uploaded and backup copies older than 30d pruned."
