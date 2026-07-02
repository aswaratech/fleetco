#!/usr/bin/env bash
#
# deploy/traccar-prune.sh — deterministic daily Tier-5 retention prune of the
# Traccar gateway's own position store (ADR-0042 c8).
#
# WHY THIS EXISTS: the ADR-0027 ≤90-day raw-location retention extends to
# EVERY store that holds a location trail, and Traccar keeps its own copy of
# every decoded position in the separate `traccar` database (tc_positions).
# Traccar 6.x has NO built-in retention (the once-documented
# database.positionsHistoryDays no longer exists in current source), so an
# external SQL prune is the only mechanism — this script is the traccar-DB
# twin of the API's in-process `traces-prune` job (same 90-day window, same
# daily cadence; a different vehicle because Prisma's single datasource
# cannot reach a second database and a raw pg client would be a new
# top-level dependency).
#
# WHAT IT DOES, in one transaction, then VACUUMs:
#   - DELETE FROM tc_events    WHERE eventtime  < now() - <retention>
#   - DELETE FROM tc_positions WHERE servertime < now() - <retention>
#     ... EXCEPT rows still referenced by tc_devices.positionid /
#     motionpositionid ("last known position" of a since-silent device —
#     Traccar dropped real FKs in its schema 6.3, so nothing would ERROR,
#     but a dangling reference breaks the device list's last-position view).
#   - Filters on SERVERTIME (receipt time), not fixtime: deterministic, and
#     a device with a bogus future clock cannot evade retention.
#
# RUN ON THE BOX via root's crontab, right after the nightly backup (which
# dumps the pre-prune state; NPT is UTC+5:45):
#
#   45 18 * * * /opt/fleetco/deploy/traccar-prune.sh >> /opt/fleetco/traccar-prune.log 2>&1
#
# CONFIGURE via environment (all optional):
#   TRACCAR_RETENTION_DAYS  retention window in days (default 90 = ADR-0027's
#                           provisional window; move both together)
#   COMPOSE_FILE            prod compose file (default docker-compose.prod.yml)
#
# psql runs inside the live postgres container as the superuser POSTGRES_USER
# (already present in that container's environment), so no password handling
# is needed here and no secret is ever on this script's command line.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "${SCRIPT_DIR}")"

cd "${PROJECT_DIR}" || {
  echo "traccar-prune: FAIL — cannot cd to project dir ${PROJECT_DIR}" >&2
  exit 1
}

COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.prod.yml}"
RETENTION_DAYS="${TRACCAR_RETENTION_DAYS:-90}"

if ! [[ "${RETENTION_DAYS}" =~ ^[0-9]+$ ]] || [ "${RETENTION_DAYS}" -lt 1 ]; then
  echo "traccar-prune: FAIL — TRACCAR_RETENTION_DAYS must be a positive integer, got '${RETENTION_DAYS}'" >&2
  exit 1
fi

echo "traccar-prune: pruning traccar positions/events older than ${RETENTION_DAYS} days ..."

# ON_ERROR_STOP + the surrounding transaction make the two DELETEs
# all-or-nothing; VACUUM runs after COMMIT (it cannot run inside a
# transaction block). $$ inside the container shell expands the container's
# own POSTGRES_USER. The heredoc interpolates ONLY the validated integer.
docker compose -f "${COMPOSE_FILE}" exec -T postgres \
  sh -c 'exec psql -q -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d traccar -f -' <<SQL
BEGIN;
DELETE FROM tc_events
 WHERE eventtime < now() - interval '${RETENTION_DAYS} days';
DELETE FROM tc_positions p
 WHERE p.servertime < now() - interval '${RETENTION_DAYS} days'
   AND NOT EXISTS (
     SELECT 1 FROM tc_devices d
      WHERE d.positionid = p.id OR d.motionpositionid = p.id
   );
COMMIT;
VACUUM (ANALYZE) tc_positions;
VACUUM (ANALYZE) tc_events;
SQL

echo "traccar-prune: PASS — window ${RETENTION_DAYS}d enforced on tc_positions/tc_events."
