# ADR-0014: Production deployment — single VPS with Docker Compose, Caddy reverse proxy, and offsite encrypted backups

- **Status:** Accepted
- **Date:** 2026-05-29
- **Decider:** Product owner (CEO)

## Context

This is the deployment ADR whose slot has been **reserved at 0014** since Phase 0. Five prior ADRs explicitly defer a production decision to it: ADR-0011 assumed "a single-VPS deployment with a one-person operations team" when it set the 99.0% SLO; ADR-0020 deferred "the eventual production image" and "the production Redis choice" here; ADR-0013 deferred the secrets-store choice and the encryption-at-rest mechanism here; ADR-0015 deferred where the production session secret lives; and ADR-0021 deferred the production cookie domain, the `secure` posture, the production CORS origin ("likely a same-origin proxy"), and production admin seeding. This ADR closes all of those.

The decision is forced now because Phase 1 is content-complete but **not yet in daily use**, and the roadmap gates Phase 2 on Phase 1 running in production (`docs/product/roadmap.md` §"Phase 1 — The Spine"; `docs/retrospectives/phase-1.md` gate). The remaining gate work — first deploy, restore-from-backup test, live SLI/DORA reporting — all depends on a production environment existing.

The thing being deployed is modest. The API (`apps/api`, NestJS, `node dist/main.js`) and the web admin (`apps/web`, Next.js, `next start`) are two Node 24 processes. They need exactly one primary datastore — **PostgreSQL 16 with the PostGIS extension** (the baseline migration runs `CREATE EXTENSION postgis`, so the database must support it, even though no geometry columns exist yet — PostGIS is Phase-2 scaffolding) — and **Redis 7** (today used only by the `/health/ready` probe; BullMQ and Cloudflare R2 are named in the stack but not yet wired). The production environment surface is small: required `DATABASE_URL`, `REDIS_URL`, `BETTER_AUTH_SECRET` (≥32 bytes), `BETTER_AUTH_URL`, plus `CORS_ORIGIN` and the web's `NEXT_PUBLIC_API_URL`; optional `SENTRY_DSN` and `OTEL_EXPORTER_OTLP_ENDPOINT` (ADR-0024); and `ADMIN_EMAIL`/`ADMIN_PASSWORD` used only by the one-off seed. The startup order is deterministic: `prisma migrate deploy` (idempotent; never `db push`) → start the API → start the web.

The operator is one person — the CEO — who is technically literate but not a hands-on coder. The reliability target (ADR-0011) is deliberately modest (99.0% over 28 days ≈ 7 h/28-day budget), the recovery objectives are RPO 24 h / RTO 4 h (ADR-0013), and backup retention is 30 days (ADR-0013). Cost matters for a single-company internal tool in Nepal. The operator chose the single-VPS shape over a managed PaaS or a hybrid (see Alternatives).

## Decision

**Deploy FleetCo as a single VPS running every service under Docker Compose behind a Caddy reverse proxy, with secrets in an on-box root-owned env file, provider disk encryption at rest, and a daily `pg_dump` encrypted and shipped offsite to Cloudflare R2 — operated by hand via the deploy/rollback/restore runbooks, with images built and SBOM-generated in CI.** Nine commitments define the shape:

1. **Topology — one VPS, Docker Compose.** A single 2–4 GB VPS (Hetzner recommended for price/performance; DigitalOcean or Linode are equivalent and swappable — the choice is not load-bearing) runs a Compose project with five services: `api`, `web`, `postgres` (`postgis/postgis:16-3.5`, matching CI), `redis` (`redis:7-alpine`, matching dev — ADR-0020's deferred "production Redis choice" is resolved as plain Redis 7; at this scale Redis Enterprise/Valkey are unwarranted), and `caddy`. Postgres and Redis data live on host-mounted volumes on the VPS's (encrypted) disk.

2. **Same-origin via Caddy.** Caddy terminates TLS for one hostname (e.g. `app.fleetco.example`) and serves the web app while reverse-proxying `/api/*`, `/auth/*`, and `/health*` to the API container. Serving web and API under one origin makes session cookies first-party and makes CORS trivial. This resolves the production auth settings ADR-0021 deferred: `BETTER_AUTH_URL` = the single public origin, cookies `secure` + same-site, and `CORS_ORIGIN` = that same origin (the cross-port dev CORS dance in `main.ts` collapses to one entry in production).

3. **TLS.** Caddy's automatic HTTPS (Let's Encrypt) provides TLS 1.2+ in transit, satisfying ADR-0013's transit-encryption requirement with zero manual certificate management.

4. **Secrets — on-box env file (Phase 1), sops+age the hardening path.** A single VPS has no managed secret manager, so ADR-0013's "deployment platform's native secret management" is realized here as a root-owned, `chmod 600`, gitignored `.env` on the box, injected into containers via Compose `env_file`. The trust boundary is the VPS's disk encryption plus OS access control; this is stated honestly — anyone with root on the box can read the secrets, which is inherent to single-VPS hosting. The recommended hardening, to be adopted when convenient, is **sops + age**: secrets encrypted at rest in the (private) repo and decrypted on the box at deploy time, which adds versioning and removes plaintext-at-rest without introducing an external service. Tier 1 values (`BETTER_AUTH_SECRET`, the `DATABASE_URL`/`REDIS_URL` passwords, `SENTRY_DSN`, `ADMIN_PASSWORD`) never enter source or logs, per ADR-0013.

5. **Encryption at rest.** Rely on the VPS provider's full-disk encryption for the data volume (ADR-0013 permits "filesystem-level encryption on the VPS"). LUKS on a dedicated data volume is the named hardening option if the provider's default is judged insufficient.

6. **Backups — daily, encrypted, offsite to R2.** A cron job on the box runs `pg_dump` nightly, gzips and `age`-encrypts the dump, and uploads it to a Cloudflare R2 bucket (the first concrete use of R2, which the stack already names), with **30-day retention** and pruning older copies. This satisfies RPO 24 h. The restore runbook is verified within two weeks of the first deploy (roadmap), proving RTO 4 h. Backups are offsite (R2, not the same VPS) so a lost box is recoverable.

7. **Deploy pipeline — CI builds images + SBOM; a manual job deploys.** CI (extending `.github/workflows/`) builds the `api` and `web` Docker images, generates a **CycloneDX SBOM** for each (this is the one ADR-0012 security-baseline item still deferred — it lands here), and pushes images tagged by commit SHA to GHCR. A `workflow_dispatch` deploy job SSHes to the VPS, pulls the tagged images, runs `prisma migrate deploy`, and `docker compose up -d`. All third-party actions stay pinned to commit SHAs (ADR-0012). Deploy frequency and lead time feed the DORA metrics (ADR-0010). *(The concrete `Dockerfile`s, `docker-compose.prod.yml`, `Caddyfile`, the backup script, and the deploy workflow are the implementation follow-on once this ADR is accepted; this ADR fixes the decision and the runbooks describe the procedure.)*

8. **Rollback by previous image tag.** Because images are SHA-tagged in GHCR, rollback is redeploying the previous good tag (`docker compose up -d` with the prior tag) — no rebuild. Migrations are forward-only; a rollback that must also revert a schema change escalates to the restore-from-backup procedure. This is the rollback runbook.

9. **Admin seeding.** The single admin user is created once via `pnpm --filter @fleetco/api db:seed` run as a one-off Compose task with `ADMIN_EMAIL`/`ADMIN_PASSWORD` from the on-box env (ADR-0021's deferred production seeding).

**Explicitly deferred to Phase 2:** PostGIS geometry features (extension created but unused), in-app Cloudflare R2 uploads, BullMQ job processing, any managed/HA or multi-node data plane, and infrastructure-as-code (Terraform/Pulumi) — the roadmap itself defers IaC to Phase 2.

## Alternatives considered

**Managed PaaS (Fly.io / Render / Railway).** The platform would run the Node apps plus managed Postgres-with-PostGIS and managed Redis, with platform-handled TLS, a real secret store, and automated backups — materially less operational toil and a cleaner story for RPO/RTO. Rejected for Phase 1 on cost and control: a single-company internal tool with a modest 99.0% SLO does not need managed-service pricing, and the operator preferred owning the box. The env-var surface is portable, so a future migration to a PaaS is a contained change (revisit signal below).

**Hybrid — VPS for apps, managed data (Neon/Supabase + Upstash).** Offloads the riskiest part (the database and its backups/restore) while keeping app hosting cheap. Rejected for the same cost/control reasons and because it adds a second and third vendor relationship and network hop for marginal Phase-1 benefit; the daily-encrypted-pg_dump-to-R2 backup satisfies the recovery objectives without a managed database.

**Kubernetes / multi-node.** Rejected as gross over-engineering for a one-person team at this scale; it would also undermine ADR-0011's premise (the 99.0% SLO is sized for a single VPS, not an HA cluster) and consume operational attention that should go to the product.

**Build images on the box (git pull + `docker compose build`).** Simpler (no registry), but couples build to the production host, is slower, produces no SBOM, and gives no clean rollback artifact. Rejected in favor of CI-built, SHA-tagged images — though the very first bootstrap deploy may be done by hand on the box before the CI pipeline lands, which the deploy runbook notes.

## Consequences

**Easier.** Cheapest possible hosting; full control of the whole stack; a deployment model that exactly matches the operating assumptions of ADR-0011 (SLO), ADR-0013 (RTO/RPO), and ADR-0010 (DORA). Local `docker-compose.yml` and production differ only by image source, secrets, and the Caddy front — small cognitive distance for a solo operator. The deferred ADR-0021 auth questions get clean answers from the same-origin Caddy decision. R2 finally has a concrete use (backups), de-risking its Phase-2 in-app adoption.

**Harder.** The operator now owns OS patching, Docker upgrades, Caddy config, the backup cron, and disk monitoring on a box that is a **single point of failure** — if the VPS is lost, the service is down until a restore onto a new box (within the 4 h RTO, which the restore drill must prove). There is no horizontal scaling and no automatic failover; that is an accepted Phase-1 trade and a Phase-2 revisit. The restore drill is genuinely on the operator and must actually be run (untested backups do not exist — `docs/runbook/README.md`).

**Costs accepted.** Secrets on the box are readable by anyone with root (mitigated by disk encryption, OS access control, and the sops+age hardening path, but inherent to single-VPS). Migrations are forward-only, so a schema-breaking bad deploy escalates from the cheap tag-rollback to the slower restore-from-backup. The first deploy is hand-bootstrapped before the CI pipeline exists, so its steps are verified by execution, not by CI — which is exactly why the runbooks ship as `STATUS: DRAFT` and flip to `ACTIVE` only after the operator runs them.

## Revisit when

- **A second operator joins**, or the operator finds the OS/backup/TLS toil unsustainable → re-evaluate a managed PaaS (the env surface is portable by design).
- **Phase 2 lands telematics** (driver app + GPS streaming + BullMQ workers + R2 media): the load, the new SLIs (ADR-0011 "Revisit when"), and the move toward a distributed topology likely outgrow a single box and justify managed data and/or multiple nodes — this is the same conversation ADR-0020 pointed here for the production Redis/queue choice.
- **The 99.0% SLO is breached by VPS-level causes** (the box's single-point-of-failure or maintenance windows eat the error budget) → the error-budget policy (ADR-0011) triggers a reliability-investment cycle that may mean managed infrastructure.
- **Data volume or backup duration** grows past what a nightly `pg_dump` + R2 upload handles comfortably → move to streaming/PITR backups or a managed database with built-in PITR.
- **A real secret-management need** emerges (more operators, more services, rotation requirements) → adopt sops+age fully or a managed secret store, superseding commitment 4.
