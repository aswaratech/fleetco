# deploy

> **STATUS: DRAFT — written from ADR-0014 (single VPS + Docker Compose), not yet executed.** Promote to `STATUS: ACTIVE` with a real "Last verified" date once the first production deploy has been run end-to-end; until then treat every step as unverified. See `docs/runbook/README.md` for the runbook discipline and `docs/architecture/decisions/0014-deployment-single-vps.md` for the architecture this implements.

## When this procedure applies

- A **routine deploy**: a PR merged to `main`, CI built and pushed the `api` + `web` images to GHCR (tagged by commit SHA), and you want that version live on the production VPS.
- The **first / bootstrap deploy**: standing up the VPS for the first time (the one-time §Bootstrap steps, then the routine flow).

Placeholders below — replace with real values, never commit them: `<vps-host>` (IP or DNS of the box), `<domain>` (the single public origin, e.g. `app.fleetco.example`), `<sha>` (image tag), `<r2-bucket>` (backup bucket). The production artifacts this procedure drives are now committed on `main`: the image Dockerfiles `apps/api/Dockerfile` + `apps/web/Dockerfile` (the latter built on Next.js `output: 'standalone'`), `docker-compose.prod.yml` + `Caddyfile` + `.env.production.example` at the repo root, the operator-dispatched `deploy` workflow at `.github/workflows/deploy.yml`, and the `deploy/smoke.sh` health check. CI (`.github/workflows/ci.yml`) builds both images on every PR (the `build-images` job) and, on merge to `main`, pushes `ghcr.io/aswaratech/fleetco-api:<sha>` + `ghcr.io/aswaratech/fleetco-web:<sha>` to GHCR with a CycloneDX SBOM per image (the `push-images` job). This procedure describes how they are used; it stays `DRAFT` because no real deploy has executed it end-to-end yet, not because any artifact is missing.

## First production deploy — operator checklist

> The one-time bootstrap sequence for standing production up for the first time, in the order ADR-0014 implies. This is **`STATUS: DRAFT`** like the rest of this file — no one has run it end-to-end yet. Work top to bottom. Every step marked **(operator-only)** needs a real secret, key, or piece of infrastructure that is deliberately **out of scope** for the agent-driven deploy-prep program: provision it yourself, reference (never invent) every value, and never commit any secret it produces (CLAUDE.md, ADR-0013). The committed artifacts referenced here (`apps/api/Dockerfile`, `apps/web/Dockerfile`, `docker-compose.prod.yml`, `Caddyfile`, `.env.production.example`, `deploy/*.sh`, and the CI + deploy workflows) all exist on `main`; this checklist wires them together on the box. The detailed reference for each step is in §Procedure below.

- [ ] **1. Provision the VPS** **(operator-only)** — a 2–4 GB instance (Hetzner/DigitalOcean/Linode) with provider disk encryption on. Pick an **amd64/x86** instance: ADR-0014's `postgis/postgis:16-3.5` image is published amd64-only (see §Bootstrap step 1 and the PostGIS note in `.github/workflows/ci.yml`).
- [ ] **2. Point DNS at the box** **(operator-only)** — an A/AAAA record for `<domain>` (the `PUBLIC_DOMAIN` value) → `<vps-host>`. Caddy needs the box reachable on ports 80 + 443 for the Let's-Encrypt ACME challenge.
- [ ] **3. Install Docker Engine + the Compose plugin** on the box.
- [ ] **4. Create `/opt/fleetco/` and place the deploy artifacts there** — copy the repo's `docker-compose.prod.yml`, `Caddyfile`, and the whole `deploy/` directory (`smoke.sh`, `backup.sh`, `restore.sh`) into `/opt/fleetco/`, so `/opt/fleetco/deploy/backup.sh` exists for the cron in step 14.
- [ ] **5. Create and fill `/opt/fleetco/.env` from the template** **(operator-only — secrets)** — `cp .env.production.example /opt/fleetco/.env`, then `chown root:root` + `chmod 600` it and replace **every** placeholder: the strong `POSTGRES_PASSWORD` (kept in sync inside `DATABASE_URL`), `BETTER_AUTH_SECRET` (`openssl rand -hex 32`), the `ADMIN_EMAIL` / `ADMIN_PASSWORD` seed pair, `PUBLIC_DOMAIN`, and the `https://<domain>` URLs (`BETTER_AUTH_URL` / `CORS_ORIGIN` / `NEXT_PUBLIC_API_URL`). `.env` is never committed (ADR-0014 §4). See §Bootstrap step 4.
- [ ] **6. Generate the `age` backup keypair + create `/opt/fleetco/deploy/backup.env`** **(operator-only — secrets)** — `age-keygen` produces the recipient public key + the identity private key; store the identity per `business-continuity.md` (it is the single most catastrophic thing to lose — without it every backup is unrecoverable). Create the root-owned, `chmod 600`, gitignored `/opt/fleetco/deploy/backup.env` with `DB_USER` / `DB_NAME` / `AGE_RECIPIENT` / `R2_REMOTE` / `R2_BUCKET` (and `AGE_KEY` for restore), and configure the rclone R2 remote, per `restore-from-backup.md` → "Backup (the create side)".
- [ ] **7. Confirm the target `<sha>` images are in GHCR** — CI's `push-images` job published `ghcr.io/aswaratech/fleetco-api:<sha>` + `…-web:<sha>` on the merge-to-`main` run (check the GHCR package tag list). If the packages are private, `docker login ghcr.io` on the box first (§Bootstrap step 2) **(operator-only — PAT)**.

Then run the bring-up on the box (`cd /opt/fleetco`):

```
# 8. Pin the version to deploy (the SHA confirmed in step 7).
export IMAGE_TAG=<sha>

# 9. Start the datastores first; wait for postgres healthy.
docker compose -f docker-compose.prod.yml up -d postgres redis
docker compose -f docker-compose.prod.yml ps          # postgres should read (healthy)

# 10. Apply migrations (idempotent; no-op when none are new).
docker compose -f docker-compose.prod.yml run --rm api \
  pnpm --filter @fleetco/api exec prisma migrate deploy

# 11. Seed the first admin once (reads ADMIN_EMAIL / ADMIN_PASSWORD from .env).
docker compose -f docker-compose.prod.yml run --rm api \
  pnpm --filter @fleetco/api db:seed

# 12. Bring up api, web, caddy.
docker compose -f docker-compose.prod.yml up -d

# 13. Smoke-check the public origin (curls /health + /health/ready through Caddy).
bash deploy/smoke.sh https://<domain>
```

- [ ] **14. Install the nightly backup cron** — add the committed cron line (NPT ≈ 00:00) so `deploy/backup.sh` runs nightly, then run it by hand once and confirm a non-empty `<backup-object>` lands in `<r2-bucket>` (an untested backup does not exist — `restore-from-backup.md`):
  ```
  15 18 * * * /opt/fleetco/deploy/backup.sh >> /opt/fleetco/backup.log 2>&1
  ```
- [ ] **15. Schedule the restore-from-backup drill within two weeks** **(operator-only)** — the roadmap requires the first restore test within two weeks of this deploy. Run `deploy/restore.sh --list` then `deploy/restore.sh <backup-object>` per `restore-from-backup.md`, measure the actual RPO/RTO, and only then promote the three deploy runbooks from `STATUS: DRAFT` to `STATUS: ACTIVE`.

**After this checklist passes end-to-end:** record the deploy in `docs/operations/dora-metrics.md` (deployment frequency + lead time), and flip the `STATUS` + "Last verified" lines in `deploy.md`, `rollback.md`, and `restore-from-backup.md` to `ACTIVE` with the real date. Until then all three stay `DRAFT`.

## Procedure

### Bootstrap (one-time, by hand on the box)

1. Provision a 2–4 GB VPS (Hetzner/DigitalOcean/Linode) with provider disk encryption on. Point `<domain>` DNS at `<vps-host>` (A/AAAA). **CPU-architecture caveat:** ADR-0014 §1 specifies the `postgis/postgis:16-3.5` Postgres image, which the official registry publishes for **amd64 only** (see the comment in `.github/workflows/ci.yml`). If you provision an ARM/Ampere instance (e.g. Hetzner's cheapest CAX tier), that image will not run and the baseline migration's `CREATE EXTENSION postgis` will fail — so either pick an amd64/x86 instance to match ADR-0014, or substitute the multi-arch `imresamu/postgis:16-3.5` image the local dev compose already uses (`docker-compose.yml`). Do not change the image without re-checking the PostGIS version-compat note in `ci.yml`.
2. Install Docker Engine + the Compose plugin. Create `/opt/fleetco/`. If the GHCR packages `ghcr.io/aswaratech/fleetco-api` / `ghcr.io/aswaratech/fleetco-web` are private, authenticate the box to GHCR so it can pull them: `docker login ghcr.io -u <github-user>` with a PAT (classic, `read:packages` scope). That PAT is a Tier-1 secret (ADR-0013) — keep it in the on-box secret store, not in shell history, and list it in `business-continuity.md`'s credential inventory. (Skip this only when the packages are public, or for a first, hand-bootstrapped deploy that builds images locally on the box per ADR-0014 "Alternatives.")
3. Put `docker-compose.prod.yml` + `Caddyfile` in `/opt/fleetco/`. Caddy terminates TLS for `<domain>`, reverse-proxies `/api/*`, `/auth/*`, and `/health*` to the `api` service, and serves `web` otherwise (ADR-0014 §2).
4. Create `/opt/fleetco/.env` by copying the committed template — `cp .env.production.example /opt/fleetco/.env` — then make it **root-owned, `chmod 600`, never committed** and replace every placeholder. The template (`.env.production.example`) documents the full required set with ADR-0013 data-tier annotations: `IMAGE_TAG`, `PUBLIC_DOMAIN`, `NODE_ENV`, `POSTGRES_USER`/`POSTGRES_PASSWORD`/`POSTGRES_DB` (which must agree with the credentials embedded in `DATABASE_URL`), `DATABASE_URL`, `REDIS_URL`, `BETTER_AUTH_SECRET` (`openssl rand -hex 32`), `BETTER_AUTH_URL=https://<domain>`, `CORS_ORIGIN=https://<domain>`, `NEXT_PUBLIC_API_URL=https://<domain>`, `ADMIN_EMAIL` / `ADMIN_PASSWORD` for the one-time seed, and the optional `SENTRY_DSN` / `OTEL_EXPORTER_OTLP_ENDPOINT`. Compose also interpolates `IMAGE_TAG`, `POSTGRES_*`, and `PUBLIC_DOMAIN` from this file into the compose file itself (image tags, postgres init, Caddy).
5. Start the datastores first: `docker compose -f docker-compose.prod.yml up -d postgres redis`; wait for `postgres` healthy (`docker compose ps`).
6. Apply migrations: `docker compose -f docker-compose.prod.yml run --rm api pnpm --filter @fleetco/api exec prisma migrate deploy`.
7. Seed the admin once: `docker compose -f docker-compose.prod.yml run --rm api pnpm --filter @fleetco/api db:seed`.
8. Bring up everything: `docker compose -f docker-compose.prod.yml up -d` (api, web, caddy). Run §Health below.
9. Install the nightly backup cron — the committed `deploy/backup.sh` (`pg_dump` → `gzip` → `age`-encrypt → upload to `<r2-bucket>`, with 30-day prune). It is configured by a gitignored `/opt/fleetco/deploy/backup.env`; see the **Backup (the create side)** section of `restore-from-backup.md` for the cron line, that config convention, and the concrete commands.

> **The production `api` image carries the migrate + seed tooling — confirmed (T1).** Steps 6–7 (and the routine-deploy migrate) call `prisma migrate deploy` and `pnpm --filter @fleetco/api db:seed`. `db:seed` is `tsx scripts/seed-admin.ts`, and both `tsx` and the `prisma` CLI are devDependencies while the seed imports TypeScript source (`apps/api/scripts/seed-admin.ts` → `../src/config/env`, `../src/modules/auth/auth`), so an image pruned to `node dist/main.js` alone would fail both commands. `apps/api/Dockerfile` resolves this by **option (a)**: its runtime stage brings the whole built workspace across — the Prisma CLI + `prisma/` (schema + `migrations/`) **and** `tsx` + the seed's TypeScript sources — keeping `node_modules/.bin/{prisma,tsx}` resolvable, and its header documents the three commands the image can run (`node dist/main.js`, `prisma migrate deploy`, `db:seed`). Trimming to a prod-only tree with a separately-pinned Prisma CLI + tsx is a future image-size optimization, not a correctness requirement. This assumption — previously the reason this runbook was `DRAFT` — is now closed; the runbook stays `DRAFT` only until a real deploy has executed these steps end-to-end.

### Routine deploy

1. Confirm CI's `push-images` job built + pushed the target `<sha>` images to GHCR — `ghcr.io/aswaratech/fleetco-api:<sha>` and `…-web:<sha>` (check the merge-to-`main` CI run, or the GHCR package tag list).
2. **Preferred:** trigger the committed `deploy` workflow (`.github/workflows/deploy.yml`, `workflow_dispatch`, input `sha`) from the GitHub Actions UI — it validates the SHA, SSHes to the box (using the operator-provisioned `DEPLOY_HOST` / `DEPLOY_USER` / `DEPLOY_SSH_KEY` secrets + the `PUBLIC_DOMAIN` variable on the `production` Environment), runs steps 3–5 below, then finishes with `deploy/smoke.sh`. **Manual equivalent** (workflow unavailable):
   - `ssh <vps-host>`; `cd /opt/fleetco`; `export IMAGE_TAG=<sha>` (consumed by the compose file).
   - `docker compose -f docker-compose.prod.yml pull` (fetch new images from GHCR).
   - Migrate (idempotent; no-op when there are no new migrations): `docker compose -f docker-compose.prod.yml run --rm api pnpm --filter @fleetco/api exec prisma migrate deploy`.
   - `docker compose -f docker-compose.prod.yml up -d` (recreates api/web at the new tag; postgres/redis untouched).

### Health + smoke check (every deploy)

- **Preferred (one shot):** `bash deploy/smoke.sh https://<domain>` — the committed script curls `/health` + `/health/ready` through Caddy and exits non-zero the moment either fails (the same check the `deploy` workflow runs automatically after `up -d`). The manual breakdown:
- Liveness: `curl -fsS https://<domain>/health` → `{"ok":true}`.
- Readiness: `curl -fsS https://<domain>/health/ready` → `{"ok":true,"db":"up","redis":"up"}` (503 if DB or Redis is down). On-box alternative if `/health*` is not publicly proxied — the slim `api` image ships neither curl nor wget, so use node's global fetch (the same probe the compose healthcheck uses): `docker compose -f docker-compose.prod.yml exec api node -e "fetch('http://127.0.0.1:3001/health/ready').then(r=>r.text()).then(console.log)"`.
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
