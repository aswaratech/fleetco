# deploy

> **STATUS: DRAFT — written from ADR-0014 (single VPS + Docker Compose), not yet executed.** Promote to `STATUS: ACTIVE` with a real "Last verified" date once the first production deploy has been run end-to-end; until then treat every step as unverified. See `docs/runbook/README.md` for the runbook discipline and `docs/architecture/decisions/0014-deployment-single-vps.md` for the architecture this implements.

## When this procedure applies

- A **routine deploy**: a PR merged to `main`, CI built and pushed the `api` + `web` images to GHCR (tagged by commit SHA), and you want that version live on the production VPS.
- The **first / bootstrap deploy**: standing up the VPS for the first time (the one-time §Bootstrap steps, then the routine flow).

Placeholders below — replace with real values, never commit them: `<vps-host>` (IP or DNS of the box), `<domain>` (the single public origin, e.g. `app.fleetco.example`), `<sha>` (image tag), `<r2-bucket>` (backup bucket). The production compose file `docker-compose.prod.yml`, the `Caddyfile`, and the `deploy` workflow are the implementation follow-on from ADR-0014; this procedure describes how they are used.

## Procedure

### Bootstrap (one-time, by hand on the box)

1. Provision a 2–4 GB VPS (Hetzner/DigitalOcean/Linode) with provider disk encryption on. Point `<domain>` DNS at `<vps-host>` (A/AAAA). **CPU-architecture caveat:** ADR-0014 §1 specifies the `postgis/postgis:16-3.5` Postgres image, which the official registry publishes for **amd64 only** (see the comment in `.github/workflows/ci.yml`). If you provision an ARM/Ampere instance (e.g. Hetzner's cheapest CAX tier), that image will not run and the baseline migration's `CREATE EXTENSION postgis` will fail — so either pick an amd64/x86 instance to match ADR-0014, or substitute the multi-arch `imresamu/postgis:16-3.5` image the local dev compose already uses (`docker-compose.yml`). Do not change the image without re-checking the PostGIS version-compat note in `ci.yml`.
2. Install Docker Engine + the Compose plugin. Create `/opt/fleetco/`. Authenticate the box to GHCR so it can pull the private `api`/`web` images: `docker login ghcr.io -u <github-user>` with a PAT (classic, `read:packages` scope). That PAT is a Tier-1 secret (ADR-0013) — keep it in the on-box secret store, not in shell history, and list it in `business-continuity.md`'s credential inventory. (Skip this only for a first, hand-bootstrapped deploy that builds images locally on the box per ADR-0014 "Alternatives.")
3. Put `docker-compose.prod.yml` + `Caddyfile` in `/opt/fleetco/`. Caddy terminates TLS for `<domain>`, reverse-proxies `/api/*`, `/auth/*`, and `/health*` to the `api` service, and serves `web` otherwise (ADR-0014 §2).
4. Create `/opt/fleetco/.env` — **root-owned, `chmod 600`, never committed** — with: `NODE_ENV=production`, `DATABASE_URL`, `REDIS_URL`, `BETTER_AUTH_SECRET` (`openssl rand -hex 32`), `BETTER_AUTH_URL=https://<domain>`, `CORS_ORIGIN=https://<domain>`, `NEXT_PUBLIC_API_URL=https://<domain>`, and optionally `SENTRY_DSN` / `OTEL_EXPORTER_OTLP_ENDPOINT`. Add `ADMIN_EMAIL` / `ADMIN_PASSWORD` for the one-time seed.
5. Start the datastores first: `docker compose -f docker-compose.prod.yml up -d postgres redis`; wait for `postgres` healthy (`docker compose ps`).
6. Apply migrations: `docker compose -f docker-compose.prod.yml run --rm api pnpm --filter @fleetco/api exec prisma migrate deploy`.
7. Seed the admin once: `docker compose -f docker-compose.prod.yml run --rm api pnpm --filter @fleetco/api db:seed`.
8. Bring up everything: `docker compose -f docker-compose.prod.yml up -d` (api, web, caddy). Run §Health below.
9. Install the nightly backup cron (the `pg_dump` → `age`-encrypt → upload-to-`<r2-bucket>` script; see the **Backup (the create side)** section of `restore-from-backup.md` for the concrete commands and schedule).

> **The production `api` image must carry the migrate + seed tooling.** Steps 6–7 (and the routine-deploy migrate) call `prisma migrate deploy` and `pnpm --filter @fleetco/api db:seed`. Today `db:seed` is `tsx scripts/seed-admin.ts`, and both `tsx` and the `prisma` CLI are **devDependencies** while the seed imports TypeScript source (`apps/api/scripts/seed-admin.ts` → `../src/config/env`, `../src/modules/auth/auth`). A production `api` image built as `node dist/main.js` with dev-deps and source pruned will fail both commands. The production `Dockerfile` (the ADR-0014 §7 implementation follow-on) must therefore either (a) include the Prisma CLI + the `prisma/` schema + `migrations/` and `tsx` + `scripts/` + the sources the seed imports, or (b) provide compiled equivalents (`prisma migrate deploy` via a bundled Prisma CLI, and a compiled `node dist/scripts/seed-admin.js`). Verify this against the Dockerfile when it lands — it is an unverified assumption today, which is why this runbook is `DRAFT`.

### Routine deploy

1. Confirm CI built the target `<sha>` images to GHCR (check the run / the GHCR tag list).
2. **Preferred:** trigger the `deploy` GitHub Actions job (`workflow_dispatch`, input `<sha>`) — it SSHes to the box and runs steps 3–5. **Manual equivalent** (workflow unavailable):
   - `ssh <vps-host>`; `cd /opt/fleetco`; `export IMAGE_TAG=<sha>` (consumed by the compose file).
   - `docker compose -f docker-compose.prod.yml pull` (fetch new images from GHCR).
   - Migrate (idempotent; no-op when there are no new migrations): `docker compose -f docker-compose.prod.yml run --rm api pnpm --filter @fleetco/api exec prisma migrate deploy`.
   - `docker compose -f docker-compose.prod.yml up -d` (recreates api/web at the new tag; postgres/redis untouched).

### Health + smoke check (every deploy)

- Liveness: `curl -fsS https://<domain>/health` → `{"ok":true}`.
- Readiness: `curl -fsS https://<domain>/health/ready` → `{"ok":true,"db":"up","redis":"up"}` (503 if DB or Redis is down). On-box alternative if `/health*` is not publicly proxied: `docker compose -f docker-compose.prod.yml exec api wget -qO- http://localhost:3001/health/ready`.
- Log in as the admin and load one list page (e.g. Vehicles) — exercises web → API → DB end-to-end.
- Record the deploy in `docs/operations/dora-metrics.md` (deployment frequency + lead time).

## What can go wrong

- **`prisma migrate deploy` fails.** Do NOT start the new API against a half-migrated DB. Read the error; a bad migration is a SEV1/SEV2 (ADR-0011). Migrations are **forward-only**, so an image rollback does **not** undo an applied or partially-applied migration — the failed migration is recorded in the `_prisma_migrations` table, and redeploying `<good-sha>` against the diverged schema is not a fix. Decide by failure mode: if the migration failed atomically having applied nothing, fix forward (correct the migration, redeploy); if it partially applied or otherwise left the schema diverged from the last good image, do NOT roll the image back — go straight to `restore-from-backup.md` (restore the pre-deploy dump) and treat as SEV1. (`rollback.md` step 3 covers only the case of a migration that applied *successfully* and is backward-compatible.)
- **`/health/ready` returns 503 after deploy.** A datastore is down: `docker compose ps` / `docker compose logs postgres redis`. Usual causes: Postgres volume perms, Redis OOM, a wrong `DATABASE_URL`/`REDIS_URL` in `.env`.
- **Image pull fails.** GHCR auth expired or was never set up on the box (re-run the `docker login ghcr.io` from Bootstrap step 2), or `<sha>` was never pushed (check the CI run).
- **Caddy cannot obtain a certificate.** DNS not yet pointing at the box, or Let's Encrypt rate limits — `docker compose logs caddy`; the box must be reachable on 80/443.
- **Disk full** (images + volumes + backups accumulate). `docker system prune` for old images; confirm the backup cron prunes dumps older than 30 days.
- **Site broken and not quickly fixable** → run `rollback.md` (redeploy the previous tag) first, diagnose after. SEV1 if trip creation / core logging is down.

## Last verified

Not yet verified — this procedure is `DRAFT` (written from ADR-0014, not executed). Replace with the date + `STATUS: ACTIVE` after the first successful production deploy.
