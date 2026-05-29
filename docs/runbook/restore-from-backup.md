# restore-from-backup

> **STATUS: DRAFT — written from ADR-0014, not yet executed.** Promote to `STATUS: ACTIVE` with a real "Last verified" date once the first restore has actually been performed — the roadmap requires this test **within two weeks of the first production deploy** (untested backups do not exist — `docs/runbook/README.md`). See `docs/architecture/decisions/0014-deployment-single-vps.md`.

## When this procedure applies

Data loss or corruption: a dropped/corrupted database, a destructive migration that rollback cannot undo, accidental bulk deletion, or rebuilding on a fresh VPS after losing the box. Recovery objectives (ADR-0013): **RPO 24 h** (at most one day's data lost — backups are nightly) and **RTO 4 h** (service back within four hours). Backups are daily `pg_dump`s, gzipped + `age`-encrypted, in Cloudflare R2 with 30-day retention (ADR-0014 §6).

Placeholders: `<vps-host>`, `<r2-bucket>`, `<backup-object>` (the dated dump, e.g. `fleetco-2026-05-29.sql.gz.age`), `<age-key>` (decryption key — from the secret store / sealed envelope per `business-continuity.md`).

## Procedure

1. **Stop writes.** `ssh <vps-host>`; `cd /opt/fleetco`; `docker compose -f docker-compose.prod.yml stop api web` (leave `postgres` up). Nothing should write during the restore.
2. **Fetch the backup** from R2: download `<backup-object>` from `<r2-bucket>` (rclone or aws-cli configured for R2). Choose the most recent good dump — or the last one *before* the corrupting event.
3. **Decrypt + decompress:** `age -d -i <age-key> <backup-object> | gunzip > /tmp/restore.sql`.
4. **Restore into a clean database, verify, then cut over** (safer than overwriting the live DB in place):
   - Create a scratch database; load the dump into it.
   - Sanity-check: row counts on `Vehicle` / `Trip` / `FuelLog` / `ExpenseLog`, the latest `createdAt`, and that the admin `User` is present.
   - Once verified, cut over — repoint `DATABASE_URL` at the restored DB (or rename it into place); only drop+reload the live DB directly if in-place cutover is required.
5. **Migration safety check:** `docker compose -f docker-compose.prod.yml run --rm api pnpm --filter @fleetco/api exec prisma migrate deploy` (the dump is already at its schema; this should be a no-op).
6. **Bring the app back:** `docker compose -f docker-compose.prod.yml up -d`; run the `deploy.md` health + smoke checks.
7. **Record + postmortem:** capture the actual data-loss window (RPO) and time-to-recover (RTO) in a postmortem (`docs/postmortems/`); a data-loss event is SEV1/SEV2 (ADR-0011).

## What can go wrong

- **The backup will not decrypt** (wrong/lost `<age-key>`). Catastrophic — and exactly what the within-two-weeks test exists to catch. Verify the key is recoverable per `business-continuity.md` (sealed envelope / secret store) *before* you ever need it.
- **The dump is corrupt or truncated** (interrupted upload). Try the previous day's dump (30-day retention gives headroom); investigate the backup cron.
- **Restore exceeds RTO 4 h** (large DB, slow download). The rehearsal measures this; if it is close, pre-stage tooling or move toward streaming/PITR backups (ADR-0014 "Revisit when").
- **PostGIS missing on a fresh box.** The dump assumes the `postgis` extension; use the `postgis/postgis:16-3.5` image so the baseline migration's `CREATE EXTENSION postgis` succeeds.
- **Restoring the wrong (too-recent, already-corrupt) dump.** Establish the corrupting event's time first, then restore the last dump before it.

## Last verified

Not yet verified — `DRAFT`. The roadmap requires the first restore test within two weeks of the first production deploy; replace with the date + `STATUS: ACTIVE` (and the measured RPO/RTO) once that test passes.
