# restore-from-backup

> **STATUS: DRAFT — written from ADR-0014, not yet executed.** Promote to `STATUS: ACTIVE` with a real "Last verified" date once the first restore has actually been performed — the roadmap requires this test **within two weeks of the first production deploy** (untested backups do not exist — `docs/runbook/README.md`). See `docs/architecture/decisions/0014-deployment-single-vps.md`.

## When this procedure applies

Data loss or corruption: a dropped/corrupted database, a destructive migration that rollback cannot undo, accidental bulk deletion, or rebuilding on a fresh VPS after losing the box. Recovery objectives (ADR-0013): **RPO 24 h** (at most one day's data lost — backups are nightly) and **RTO 4 h** (service back within four hours). Backups are daily `pg_dump`s, gzipped + `age`-encrypted, in Cloudflare R2 with 30-day retention (ADR-0014 §6).

Placeholders: `<vps-host>`, `<r2-bucket>`, `<backup-object>` (the dated dump, e.g. `fleetco-2026-05-29.sql.gz.age`), `<db-user>` / `<db-name>` (the production Postgres role and database from `DATABASE_URL`), `<age-recipient>` (the `age` **public** key the backup is encrypted _to_), and `<age-key>` (the `age` **identity** / private key that decrypts it). The `age` identity is the single most catastrophic thing to lose — without it every backup is unrecoverable — so it is tracked in `business-continuity.md`'s credential inventory and sealed envelope. Retrieve it from the on-box identity file (e.g. root-owned `/opt/fleetco/secrets/age-identity.txt`, `chmod 600`) or, if the box itself is gone, from the sealed envelope / secret store per `business-continuity.md`.

## Backup (the create side)

The restore below is only testable if the backups it consumes are actually produced. ADR-0014 §6 commits to a nightly `pg_dump`, gzipped + `age`-encrypted, shipped to Cloudflare R2 with 30-day retention (satisfying RPO 24 h). The backup script itself is the ADR-0014 §7 implementation follow-on; the procedure it automates is below (run on the box; `STATUS: DRAFT` until the cron is installed and a produced dump has been restored end-to-end).

1. **Dump → compress → encrypt** in one pipe, so no plaintext dump ever lands on disk:
   ```
   docker compose -f docker-compose.prod.yml exec -T postgres \
     pg_dump -U <db-user> -d <db-name> --no-owner --clean --if-exists \
     | gzip \
     | age -r <age-recipient> \
     > /tmp/fleetco-$(date -u +%F).sql.gz.age
   ```
   Encrypt **to the recipient public key** (`-r <age-recipient>`); the matching `age` identity (`<age-key>`) is what decrypts it at restore time and lives per `business-continuity.md` — never on the backup path itself.
2. **Upload to R2** (rclone with an R2 remote, or aws-cli against the R2 S3 endpoint), then delete the local temp file:
   ```
   rclone copy /tmp/fleetco-$(date -u +%F).sql.gz.age r2:<r2-bucket>/
   # or: aws s3 cp /tmp/fleetco-$(date -u +%F).sql.gz.age \
   #       s3://<r2-bucket>/ --endpoint-url https://<account>.r2.cloudflarestorage.com
   ```
3. **Schedule nightly** via the box's crontab. NPT is UTC+5:45, so `15 18 * * *` UTC ≈ 00:00 Nepal time. Wrap steps 1–2 in `/opt/fleetco/backup.sh` and log:
   ```
   15 18 * * * /opt/fleetco/backup.sh >> /opt/fleetco/backup.log 2>&1
   ```
4. **Prune to 30-day retention** (ADR-0013) at the end of the script:
   ```
   rclone delete --min-age 30d r2:<r2-bucket>/
   ```
5. **Verify the morning after the first run** that a new `<backup-object>` landed in `<r2-bucket>` and is non-empty; a missing or 0-byte dump is a backup failure to fix _before_ it becomes a data-loss event. An untested backup does not exist (`docs/runbook/README.md`) — the within-two-weeks restore drill below is what proves this side actually works.

## Restore procedure

1. **Stop writes.** `ssh <vps-host>`; `cd /opt/fleetco`; `docker compose -f docker-compose.prod.yml stop api web` (leave `postgres` up). Nothing should write during the restore.
2. **Fetch the backup** from R2: download `<backup-object>` from `<r2-bucket>` (rclone or aws-cli configured for R2). Choose the most recent good dump — or the last one *before* the corrupting event.
3. **Decrypt + decompress:** `age -d -i <age-key> <backup-object> | gunzip > /tmp/restore.sql` — where `<age-key>` is the `age` identity file retrieved per the placeholders note above (on-box `/opt/fleetco/secrets/age-identity.txt`, or the sealed envelope / secret store from `business-continuity.md` if rebuilding on a fresh box).
4. **Restore into a clean database, verify, then cut over** (safer than overwriting the live DB in place). Use the `postgres` service's client tools via `docker compose -f docker-compose.prod.yml exec -T postgres ...`:
   - **Load into a scratch DB:** `createdb -U <db-user> fleetco_restore`, then load `/tmp/restore.sql` into it (`psql -U <db-user> -d fleetco_restore` reading the file in via `-T`).
   - **Sanity-check:** row counts on `Vehicle` / `Trip` / `FuelLog` / `ExpenseLog`, the latest `createdAt`, and that the admin `User` is present.
   - **Cut over — pick one branch:**
     - **Branch A (preferred — repoint, non-destructive):** edit `/opt/fleetco/.env` so `DATABASE_URL` names `fleetco_restore` instead of `<db-name>`, then `docker compose -f docker-compose.prod.yml up -d api web` so the apps pick up the new env. The original (corrupt) DB is left intact for forensics.
     - **Branch B (in-place — only if the DB name must stay `<db-name>`):** destructive, so do it only after Branch A's sanity-check has passed on the scratch copy. Terminate connections, then `dropdb -U <db-user> <db-name>` → `createdb -U <db-user> <db-name>` → load `/tmp/restore.sql` into it.
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
