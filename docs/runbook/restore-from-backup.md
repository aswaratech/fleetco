# restore-from-backup

> **STATUS: ACTIVE — first restore drill run and passed 2026-07-19, the same day as the first production deploy** (13 days ahead of the roadmap's two-week requirement; see §Last verified for the measured RPO/RTO). See `docs/architecture/decisions/0014-deployment-single-vps.md`.

## When this procedure applies

Data loss or corruption: a dropped/corrupted database, a destructive migration that rollback cannot undo, accidental bulk deletion, or rebuilding on a fresh VPS after losing the box. Recovery objectives (ADR-0013): **RPO 24 h** (at most one day's data lost — backups are nightly) and **RTO 4 h** (service back within four hours). Backups are daily `pg_dump`s, gzipped + `age`-encrypted, in Cloudflare R2 with 30-day retention (ADR-0014 §6).

Placeholders: `<vps-host>`, `<r2-bucket>`, `<backup-object>` (the dated dump, e.g. `fleetco-2026-05-29.sql.gz.age`), `<db-user>` / `<db-name>` (the production Postgres role and database from `DATABASE_URL`), `<age-recipient>` (the `age` **public** key the backup is encrypted _to_), and `<age-key>` (the `age` **identity** / private key that decrypts it). The `age` identity is the single most catastrophic thing to lose — without it every backup is unrecoverable — so it is tracked in `business-continuity.md`'s credential inventory and sealed envelope. Retrieve it from the on-box identity file (e.g. root-owned `/opt/fleetco/secrets/age-identity.txt`, `chmod 600`) or, if the box itself is gone, from the sealed envelope / secret store per `business-continuity.md`.

## Backup (the create side)

The restore below is only testable if the backups it consumes are actually produced. ADR-0014 §6 commits to a nightly `pg_dump`, gzipped + `age`-encrypted, shipped to Cloudflare R2 with 30-day retention (satisfying RPO 24 h). That procedure is now a committed, `shellcheck`-clean script — **`deploy/backup.sh`** (it was the ADR-0014 §7 implementation follow-on). The commands it runs are documented below so a reader knows exactly what it does; `STATUS: DRAFT` until the cron is installed on the box and a produced dump has been restored end-to-end.

**Configure + run.** `deploy/backup.sh` hardcodes no secret (ADR-0013 / CLAUDE.md); every operator value is an environment variable with a fail-fast `:?` guard. Define them in a root-owned, `chmod 600`, gitignored `/opt/fleetco/deploy/backup.env` (the script sources it automatically — the same file `deploy/restore.sh` reads), or inline them on the crontab line:

```
DB_USER        the production Postgres role        (= POSTGRES_USER in .env)
DB_NAME        the production Postgres database     (= POSTGRES_DB   in .env)
AGE_RECIPIENT  the age PUBLIC key the dump is encrypted to (<age-recipient>)
R2_REMOTE      the rclone remote name for R2 (e.g. r2)
R2_BUCKET      the R2 bucket name (<r2-bucket>)
# optional: COMPOSE_FILE (default docker-compose.prod.yml), BACKUP_TMPDIR (default /tmp)
```

Run `deploy/backup.sh` by hand once to confirm a dump lands in R2, then schedule it (step 3 below). What the script does, step by step:

1. **Dump → compress → encrypt** in one pipe, so no plaintext dump ever lands on disk (`set -o pipefail` makes a `pg_dump` failure fail the whole script instead of shipping a truncated `.age`):
   ```
   docker compose -f docker-compose.prod.yml exec -T postgres \
     pg_dump -U "$DB_USER" -d "$DB_NAME" --no-owner --clean --if-exists \
     | gzip \
     | age -r "$AGE_RECIPIENT" \
     > /tmp/fleetco-$(date -u +%F).sql.gz.age
   ```
   Encrypt **to the recipient public key** (`-r <age-recipient>`); the matching `age` identity (`<age-key>`) is what decrypts it at restore time and lives per `business-continuity.md` — never on the backup path itself.
2. **Upload to R2** (rclone with an R2 remote, or aws-cli against the R2 S3 endpoint), then remove the local temp file (the script's `trap … EXIT` does this even on failure):
   ```
   rclone copy /tmp/fleetco-$(date -u +%F).sql.gz.age "$R2_REMOTE:$R2_BUCKET/"
   # or: aws s3 cp /tmp/fleetco-$(date -u +%F).sql.gz.age \
   #       s3://<r2-bucket>/ --endpoint-url https://<account>.r2.cloudflarestorage.com
   ```
3. **Schedule nightly** via the box's crontab. NPT is UTC+5:45, so `15 18 * * *` UTC ≈ 00:00 Nepal time. The cron line runs the committed script and logs:
   ```
   15 18 * * * /opt/fleetco/deploy/backup.sh >> /opt/fleetco/backup.log 2>&1
   ```
4. **Prune to 30-day retention** (ADR-0013) at the end of the script:
   ```
   rclone delete --min-age 30d "$R2_REMOTE:$R2_BUCKET/"
   ```
5. **Verify the morning after the first run** that a new `<backup-object>` landed in `<r2-bucket>` and is non-empty; a missing or 0-byte dump is a backup failure to fix _before_ it becomes a data-loss event. An untested backup does not exist (`docs/runbook/README.md`) — the within-two-weeks restore drill below is what proves this side actually works.

## Restore procedure

The fetch → decrypt → load-into-scratch-DB → sanity-check span (steps 2–4 below) is automated by the committed **`deploy/restore.sh`**, configured by the same gitignored `deploy/backup.env` (it additionally reads `AGE_KEY`, the `age` identity that decrypts the dump). Run `deploy/restore.sh --list` to see the available dumps, then `deploy/restore.sh <backup-object>`: it loads into the scratch `fleetco_restore` DB, prints the row-count / admin-`User` sanity check, and **STOPS** — it never drops or overwrites the live database, so the cut-over (step 4) stays a deliberate by-hand step. The manual commands are kept below for the reader, and for a fresh-box rebuild where the script's assumption of a running `postgres` container does not yet hold.

1. **Stop writes.** `ssh <vps-host>`; `cd /opt/fleetco`; `docker compose -f docker-compose.prod.yml stop api web` (leave `postgres` up). Nothing should write during the restore.
2. **Fetch the backup** from R2: download `<backup-object>` from `<r2-bucket>` (rclone or aws-cli configured for R2). Choose the most recent good dump — or the last one *before* the corrupting event.
3. **Decrypt + decompress:** `age -d -i <age-key> <backup-object> | gunzip > /tmp/restore.sql` — where `<age-key>` is the `age` identity file retrieved per the placeholders note above (on-box `/opt/fleetco/secrets/age-identity.txt`, or the sealed envelope / secret store from `business-continuity.md` if rebuilding on a fresh box).
4. **Restore into a clean database, verify, then cut over** (safer than overwriting the live DB in place). Use the `postgres` service's client tools via `docker compose -f docker-compose.prod.yml exec -T postgres ...`:
   - **Load into a scratch DB:** `createdb -U <db-user> fleetco_restore`, then load `/tmp/restore.sql` into it (`psql -U <db-user> -d fleetco_restore` reading the file in via `-T`).
   - **Sanity-check:** row counts on the `vehicle` / `trip` / `fuel_log` / `expense_log` tables, the latest `createdAt`, and that the admin `user` row is present. (These are the Prisma `@@map` snake_case table names — the PascalCase model names do not exist in the database; `user` must be double-quoted in psql, it is a reserved word.)
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

- **2026-07-19** — first restore drill run and passed, the same day as the first production deploy (13 days ahead of the two-week requirement). The create side ran first for real: `backup.sh` dumped, gzipped, age-encrypted, and uploaded `fleetco-2026-07-19.sql.gz.age` (12.5 KB) to the R2 bucket `fleetco-backups` (age identity at `/opt/fleetco/secrets/age-identity.txt`, operator's offsite copy in their password manager). `restore.sh` then fetched, decrypted, and loaded it into the `fleetco_restore` scratch DB in **1.9 s end-to-end**, and the sanity check matched production truth exactly (1 user — the seeded admin — and 0 business rows on day zero). **Measured RPO:** minutes (the dump was fresh); the nightly cron bounds it at ≤24 h per ADR-0014. **Measured RTO** at current data size: ~2 s fetch+decrypt+load plus the operator cutover — far inside the 4 h target; re-measure as data grows. Tooling note: Ubuntu's rclone 1.60 hits a benign 501-then-retry-succeeds on R2 uploads; upgrade rclone from rclone.org if the nightly log noise matters.
