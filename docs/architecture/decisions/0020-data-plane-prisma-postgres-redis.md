# ADR-0020: Prisma, Postgres + PostGIS, Redis, and Docker Compose as the data-plane stack

- **Status:** Accepted
- **Date:** 2026-05-21
- **Decider:** Product owner (CEO)

## Context

`docs/architecture/overview.md` and `CLAUDE.md` name Prisma as the ORM and migration tool, Postgres with PostGIS as the primary database, Redis with BullMQ as the cache and job-queue substrate, and "Docker Compose" as the implicit local-development orchestration ("run it locally"). ADR-0002 covers the choice of PostgreSQL itself; nothing else in this constellation has a dedicated ADR. The threshold from BOOTSTRAP step 7 — "would a future session need to know this?" — is clearly met for the rest. ADR-0018 closed the equivalent gap for the API stack (NestJS + nestjs-pino + Sentry); ADR-0019 closed it for the frontend stack (Next.js + Tailwind + shadcn-ui). This ADR is the symmetric closure for the data-plane stack and its local-development substrate.

The four choices are interdependent. Prisma needs a database; Postgres-with-PostGIS is the only sensible relational+geospatial combination at our scale per ADR-0002; Redis is the lightweight cache and queue substrate the modular monolith uses to keep the API stateless and to absorb slow work; Docker Compose is the orchestrator that brings these up locally with one command. Choosing one without the others is incoherent: Prisma without Postgres is unrooted, Postgres without Prisma is hand-written SQL we already rejected, Redis without BullMQ is a Phase-2-and-later cache nobody is currently using, and a stack without Docker Compose is a stack that fails the "fresh machine to running services in under ten minutes" goal that `docs/runbook/dev-setup.md` is meant to make real.

The decision is being made at Phase 0 Ticket 9 — the ticket that first creates `docker-compose.yml`, the Prisma schema and baseline migration, and the first concrete draft of the dev-setup runbook. The ADR lands together with that code so future readers see the decision and its first implementation in one diff.

## Decision

The FleetCo data plane is **Prisma 6** as the ORM and migration tool, talking to **PostgreSQL 16 with the PostGIS 3.5 extension** for primary data, with **Redis 7.4** for cache and the **BullMQ** job queue, all brought up locally via **Docker Compose** with a single `docker compose up -d` from the repo root.

The seven specific commitments are:

1. **ORM and migration tool: Prisma 6.** Schema in `apps/api/prisma/schema.prisma`. Migrations in `apps/api/prisma/migrations/<timestamp>_<name>/migration.sql`, applied via `pnpm --filter @fleetco/api prisma migrate dev`. Migrations are versioned and never edited after applying (CLAUDE.md). `prisma db push` is forbidden outside local exploration (CLAUDE.md). The PostGIS extension is declared in the datasource block with `previewFeatures = ["postgresqlExtensions"]` and `extensions = [postgis]`; this flag has been stable since Prisma 4.5 and is the canonical way to manage Postgres extensions through Prisma migrations.

2. **Prisma location: `apps/api/prisma/`.** Tightly coupled with the only Phase-0 consumer. Extraction to `packages/db/` is the named exit ramp when a second consumer (driver app in Phase 2, jobs runner if introduced) needs to share the generated client. The extraction is a mechanical move; the cost of doing it later is small, the cost of doing it speculatively now is real.

3. **Database: Postgres 16 + PostGIS 3.5, via `imresamu/postgis:16-3.5`.** Postgres 16 matches ADR-0002 and is in active support through November 2028. The PostGIS image is `imresamu/postgis:16-3.5` rather than the official `postgis/postgis:16-3.5` because the official image publishes no `linux/arm64` manifest as of this writing, and the sole Phase-0 developer is on Apple Silicon. `imresamu/postgis` is a multi-arch mirror (amd64 + arm64) maintained by Imre Samu, a PostGIS Docker contributor; it tracks the official image's tagging and content closely. The eventual production image (named by ADR-0014, reserved) may differ; that divergence is acceptable because the schema and migrations are portable across both image sources.

4. **Image init script overridden.** The `imresamu/postgis` image's `/docker-entrypoint-initdb.d/10_postgis.sh` unconditionally enables four PostGIS-related extensions (`postgis`, `postgis_topology`, `fuzzystrmatch`, `postgis_tiger_geocoder`) in the `$POSTGRES_DB` on first volume initialization. This conflicts with our "migrations are the single source of truth for schema state" discipline because it produces drift between the live database and migration history on every fresh `docker compose up`. We mount `docker/postgres-init/disable-auto-extensions.sh` over the image's init script via the compose `volumes:` list; the override is a documented no-op that lets Prisma migrations own extension state without per-developer reset workflows.

5. **Cache and queue: Redis 7.4 + BullMQ, via `redis:7-alpine`.** Redis 7.4 is the last fully-OSS major before Redis's 2024 license change to AGPLv3/SSPL/RSALv2. BullMQ is well-tested against Redis 7. The eventual production Redis choice — Redis Enterprise, Redis 8, Valkey, or a managed equivalent — is named by ADR-0014; for local development, Redis 7.4 has no license complications and matches what most BullMQ documentation assumes.

6. **Local orchestration: Docker Compose, modern Compose Specification.** The compose file lives at the repo root (`./docker-compose.yml`). No top-level `version:` key (deprecated in modern Compose). Named volumes (`postgres_data`, `redis_data`) hold the data across `docker compose down/up`; `docker compose down -v` wipes them. Host ports are parameterized via Compose variable substitution (`${POSTGRES_PORT:-5432}:5432` and `${REDIS_PORT:-6379}:6379`) so developers running sibling Docker projects on the canonical ports can override via a gitignored repo-root `.env` file without changing committed files.

7. **Baseline migration enables only PostGIS.** The baseline migration's only act is `CREATE EXTENSION IF NOT EXISTS "postgis";`. No tables are declared in Phase 0; the first table — better-auth's session storage — lands in Ticket 10. This is a deliberate small deviation from the kickoff plan's literal "empty baseline migration" wording, on the grounds that a database with no schema at all is a less honest starting state than a database with the extension we have explicitly chosen to depend on.

## Alternatives considered

### For the ORM

**Drizzle ORM.** TypeScript-native, fast, SQL-first. Rejected because (a) its migration story is less mature than Prisma's — `drizzle-kit` is still evolving its discipline around generated migrations, while Prisma's migration workflow is the canonical reference for the "schema-first + versioned migration" pattern we want; (b) AI-agent training mass on Prisma is substantially greater (per the ADR-0005 argument); (c) its PostGIS support is less developed.

**TypeORM.** The historical NestJS-default ORM. Rejected because (a) decorator-heavy models repeat what NestJS decorators already give us with diminishing returns; (b) historical schema-drift footguns and quieter migration tooling; (c) Prisma's `prisma generate` produces structurally simpler types that align better with the "TypeScript end-to-end with strict mode" choice in ADR-0005.

**Kysely.** Type-safe query builder, no migration discipline of its own. Rejected because we want migration discipline as a first-class feature, not as a separately-glued-on tool. Kysely + a separate migration tool is more moving parts than Prisma alone.

**Raw SQL via `pg`.** No type generation; full control. Rejected because the type safety we get from Prisma's generated client is exactly the thing we want from a TypeScript-end-to-end codebase, and re-implementing it by hand would be a poor use of solo-founder time.

### For the Postgres major version

**Postgres 17.** GA October 2024; mature by 2026-05-21. Rejected because (a) the kickoff plan literal names 16; (b) Postgres 16's active-support window extends to November 2028, which comfortably exceeds Phase 1's and Phase 2's horizons; (c) every managed Postgres-as-a-service offering supports 16 robustly, so the production choice in ADR-0014 stays open without lock-in.

**Postgres 15 or older.** Closer to EOL, less interesting features. Rejected on age alone.

### For the PostGIS image

**Official `postgis/postgis:16-3.5`.** The canonical PostGIS Docker image. Rejected because it publishes no `linux/arm64` manifest; the sole Phase-0 developer is on Apple Silicon, and forcing amd64 via Rosetta 2 emulation imposes a real, measurable latency cost on every dev round-trip. The eventual production image can be the official one if it runs on amd64 Linux.

**Base `postgres:16-alpine` + `apt install postgis` at runtime.** Alpine does not ship PostGIS in its package repos; even on Debian variants, runtime installation is slow on first up and fragile. Rejected.

**Custom Dockerfile (`FROM postgres:16-bookworm` + `RUN apt-get install postgresql-16-postgis-3`).** Rejected because it requires a `docker compose build` step and inverts our "image-as-input, schema-as-output" mental model.

**Force `postgis/postgis:16-3.5` with `platform: linux/amd64`.** Rejected for the Rosetta-latency reason above.

### For the init-script handling

**Accept the image's auto-enable and declare all four extensions in `schema.prisma`.** Rejected because it bakes "the image's choice" into our schema (`fuzzystrmatch` and `postgis_tiger_geocoder` have no current FleetCo use), creates ambient assumptions about which extensions exist, and re-introduces drift the next time we change image sources.

**Tell developers to run `prisma migrate reset --force` once after first `docker compose up`.** Rejected because it puts a one-time gotcha in the dev-setup procedure that every fresh contributor would hit and forget about, and because "migrations are the single source of truth" is more honest if the database state actually starts where migrations expect it.

### For the cache + queue

**Valkey (BSD-3 fork of Redis 7.4).** Maintained by the Linux Foundation. License-clean for the eventual production choice. Rejected for Phase 0 because BullMQ's documentation and ecosystem still center on Redis, and the test-coverage / community-feedback loop is more mature against `redis:7-alpine` than against `valkey/valkey:8-alpine`. The production decision in ADR-0014 may pick Valkey; the local-dev choice does not bind the production choice.

**Redis 8.** Newer major; AGPLv3 / SSPL / RSALv2 multi-license. Rejected because the license complexity is a real consideration for production and we should not commit Phase 0 to a choice the production conversation may want to reopen.

**Dragonfly or KeyDB (Redis-protocol-compatible alternatives).** Different operational characteristics. Rejected as premature optimization at our scale.

**Postgres `LISTEN/NOTIFY` for queues, no Redis.** Possible. Rejected because (a) Redis is also the cache and the session store (`better-auth`'s sessions per ADR-0015 will use it indirectly via Postgres but Redis is needed for rate limits, etc.); (b) BullMQ on Redis is the well-trodden path for the job-queue patterns we expect; (c) Postgres-only queueing scales but loses the per-job concurrency primitives BullMQ gives us for free.

### For the local-orchestration tool

**Tilt.** Live-update orchestration for Kubernetes-shaped dev. Rejected because we don't run Kubernetes in Phase 0 and the cost of learning Tilt is paid by every contributor every day, against a benefit (live-update) we don't have.

**`devbox` / Nix.** Reproducible dev shells. Rejected because the FleetCo audience (the sole developer, plus eventual contributors) is unlikely to have Nix infrastructure already in place, and the friction of `nix-shell` on first run dominates the value at our scale.

**Host-installed Postgres + Redis** (e.g., `brew install postgresql@16 postgis redis`). Rejected because per-OS install drift is exactly the kind of "works on my machine" problem Docker Compose is designed to solve, and because sibling-project port collisions (which we already encountered in this ticket) are easier to reason about when every project's database is in a labeled container.

### For the baseline migration content

**Truly empty baseline.** Matches the kickoff plan literal. Rejected on the small grounds that a database with no extensions and no tables is a less honest starting state than one whose extension dependency (PostGIS) is explicit in migration history from day one.

**Baseline that enables PostGIS and also creates an empty `_fleetco_health` row** or other marker. Rejected as cargo-culting; nothing needs the marker.

## Consequences

### What this makes easier

Every Phase-1 module has a known shape: declare your tables in `apps/api/prisma/schema.prisma`, run `pnpm --filter @fleetco/api db:migrate`, get a versioned migration plus generated types automatically. Future agents see this consistency in the baseline migration and the README and produce code that fits. The `/health/ready` probe in `apps/api/src/modules/health/` is the canonical example of how a module talks to Prisma and Redis through DI.

The local-development entry path is one command: `docker compose up -d` brings both services online with named volumes that persist across restarts. `docs/runbook/dev-setup.md` (this same ticket's first draft) makes the fresh-machine procedure explicit.

The "migrations are versioned and never edited" discipline of CLAUDE.md is now framework-enforced. Prisma's `_prisma_migrations` table is the audit log of what has been applied; the migrations directory is the source of truth for what will be applied. Drift between the two is detected by `prisma migrate dev` and surfaced loudly. The image's init script is overridden to prevent the silent state-injection that would otherwise re-introduce drift on every fresh volume.

### What this makes harder

Every schema change now requires a Prisma migration round-trip — `prisma migrate dev` — rather than a one-shot SQL edit. This is the cost of having migration discipline; it is the cost we want to pay.

The data plane is a separate process to manage. `docker compose up/down` must be in the muscle memory of every contributor. The eventual production deployment (ADR-0014) replaces compose with whatever the deployment platform's data-plane abstraction is.

Prisma's PostGIS extension support is still preview-flagged via `previewFeatures = ["postgresqlExtensions"]`. The flag's behavior has been stable since Prisma 4.5 but is not GA-promised. If a future Prisma major stabilizes or removes the preview path, the schema-declaration syntax may change; the migration SQL itself is just standard `CREATE EXTENSION`.

The `imresamu/postgis` image source is a small divergence from the canonical "official PostGIS image" answer. A contributor reading `docker-compose.yml` for the first time will see an image they may not recognize; the inline comment plus this ADR explain why. The risk that the `imresamu/postgis` image becomes unmaintained is real but small — Imre Samu is a recognized PostGIS contributor and the image has been multi-arch-stable for years. The fallback if the image is ever unsuitable is the custom-Dockerfile path named under "Alternatives considered."

### Costs we accept

- **Image init script override is a "soft fork" of `imresamu/postgis`.** The compose bind-mount over `/docker-entrypoint-initdb.d/10_postgis.sh` is a documented workaround for a known image behavior. If the upstream image changes its init filename (unlikely but possible), the override silently stops working. The detection signal is `psql -c '\dx'` showing more than `plpgsql + postgis` after a fresh `docker compose up -d`; if that ever appears, this ADR's "Revisit when" triggers.
- **Parameterized compose ports introduce per-machine `.env` files.** A contributor with no sibling-Docker projects can use the canonical 5432 / 6379 / 3001 ports with no override. A contributor with collisions sets `POSTGRES_PORT=...` / `REDIS_PORT=...` in a gitignored repo-root `.env`, and updates `apps/api/.env`'s `DATABASE_URL` and `REDIS_URL` host ports to match. The pattern is documented in `docs/runbook/dev-setup.md` and in each affected compose / .env.example file.
- **Redis 7.4 commits us to the BullMQ-on-Redis path for Phase 1's queue work.** Switching to Valkey or Redis 8 later is straightforward at the protocol level; switching to a non-Redis-protocol queue (RabbitMQ, NATS) is a real migration the production conversation may want to take. ADR-0014 is the place that conversation lives.
- **No PgBouncer in Phase 0.** Prisma's built-in connection pool is sufficient at our scale. The revisit signal is the production deployment producing connection-saturation events; this is post-Phase-1 work at the earliest.
- **The data plane is wired into the `/health/ready` readiness probe but not into the `/health` liveness probe per ADR-0011.** A Postgres or Redis outage produces a 503 from `/health/ready` (informing orchestrators) but does not affect the SLI surface, which deliberately stays measurement-cheap. The two-endpoint split is named in `apps/api/README.md` and is the canonical pattern any future probe addition follows.
- **No internal probe timeout in Phase 0.** A hung Postgres or Redis produces a hung readiness probe response. Phase 1 may add a `Promise.race`-based short-timeout wrapper; we accept the simpler implementation now because no orchestrator is consuming the probe yet.

## Revisit when

- **Prisma 7 ships with breaking schema-syntax changes.** Migration is real work; the revisit signal is "Prisma 7 has been GA for two minor releases and the breaking-change documentation is stable."
- **Postgres 17 is the eventual production target AND Postgres 16 approaches EOL.** Switching local to 17 is one image-tag edit plus a `docker compose down -v && docker compose up -d`. The revisit signal is the production deployment in ADR-0014 picking 17.
- **The driver app (Phase 2) or a dedicated jobs runner needs Prisma client.** Extract `apps/api/prisma/` to `packages/db/`, retarget the `--schema` flag, re-export the generated client from a workspace package. The extraction is mechanical.
- **`imresamu/postgis` upstream changes the init script filename, or becomes unmaintained.** Either re-target the override (one path change in compose) or switch to the custom-Dockerfile path under "Alternatives considered."
- **`postgis/postgis` (official) publishes a `linux/arm64` manifest.** Revisit the image-source decision; the official image regains its small advantage of being canonical, at the cost of one image-tag edit.
- **The PostGIS preview-feature flag in Prisma stabilizes or is removed.** Either drop the `previewFeatures` line (stabilization) or migrate to whatever Prisma's replacement is. The migration SQL is unaffected.
- **Redis license, BullMQ behavior, or the production Redis choice in ADR-0014 changes.** Switching local Redis to Valkey or Redis 8 is one image-tag edit; switching protocols is bigger but unlikely.
- **PgBouncer becomes necessary.** Measurement-driven, post-Phase-1.
- **Compose-based local dev becomes inadequate.** Triggers a new ADR for whatever replaces it (Tilt, Tilt-equivalents, or a deploy-target-mirrored local environment).
