#!/bin/bash
# Mounted via docker-compose.yml over the imresamu/postgis image's
# /docker-entrypoint-initdb.d/10_postgis.sh. The upstream script
# unconditionally enables postgis + postgis_topology + fuzzystrmatch +
# postgis_tiger_geocoder in $POSTGRES_DB on first volume init.
#
# FleetCo enables PostGIS extensions via Prisma migrations, not at image
# init time, so migrations remain the single source of truth for the
# database schema (per CLAUDE.md's "migrations are versioned and never
# edited" discipline and ADR-0020). This no-op file replaces the upstream
# script when the volume is first initialized.
#
# template_postgis is also not created. We do not depend on it.
set -e
echo "[fleetco] PostGIS auto-enable disabled; migrations are the source of truth."
