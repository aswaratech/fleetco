# `@fleetco/api`

The FleetCo backend. NestJS 11 modular monolith per ADR-0001; the framework + observability stack is in ADR-0018; the data-plane stack (Prisma + Postgres+PostGIS + Redis) is in ADR-0020. The application surface area in Phase 0 is the `/health` and `/health/ready` endpoints; Phase 1 vertical slices live under `src/modules/<name>/` per ADR-0006.

## Local development

The full from-fresh-machine procedure is in [`docs/runbook/dev-setup.md`](../../docs/runbook/dev-setup.md). The short form:

```bash
# from the repo root
docker compose up -d
cp apps/api/.env.example apps/api/.env
pnpm install
pnpm --filter @fleetco/api prisma migrate dev
pnpm --filter @fleetco/api dev
```

The API listens on `http://localhost:${PORT:-3001}`.

## Prisma location

Prisma's schema, migrations, and generated client all live under `apps/api/prisma/`. The Prisma CLI is invoked via `pnpm --filter @fleetco/api db:migrate` / `db:generate` / `db:studio` (see `package.json` scripts).

Rationale: the API is Phase 0's only Prisma consumer, so coupling Prisma to the consumer is the least friction. When a second consumer appears — most likely a driver app in Phase 2 or a dedicated jobs runner — Prisma can extract to `packages/db/` with one of: a `pnpm` workspace move, a re-export of the generated client, and a small change to the `--schema` flag in CLI invocations. The forward-compatibility of this layout is named in ADR-0020.

## Health endpoints

| Endpoint | Status code | Body | Purpose |
|---|---|---|---|
| `GET /health` | 200 | `{"ok":true}` | Liveness. The canonical SLI probe target per ADR-0011. Must stay cheap — no dependency checks. |
| `GET /health/ready` | 200 or 503 | `{"ok":boolean,"db":"up"\|"down","redis":"up"\|"down"}` | Readiness. Probes Postgres (via `SELECT 1`) and Redis (via `PING`) in parallel. 200 if both up, 503 if either down. For orchestrators (eventual deploy ADR-0014) and CI integration tests. |

The split keeps `/health` cheap for the SLI surface and lets `/health/ready` exercise the dependency graph honestly without changing the contract that ADR-0011 names.

## Environment variables

Validated by [zod](./src/config/env.ts) at module load. Required vars throw a startup error if missing; `.env` is loaded via `dotenv` before validation. The full list:

| Variable | Required | Default | Tier (ADR-0013) | Notes |
|---|---|---|---|---|
| `NODE_ENV` | no | `development` | Tier 4 | One of `development` / `production` / `test`. |
| `PORT` | no | `3001` | Tier 4 | Override locally (e.g. `3011`) when a sibling project holds the default. |
| `SENTRY_DSN` | no | (none) | **Tier 1** | When unset, Sentry init no-ops. Production value lives in the secret store. |
| `LOG_LEVEL` | no | `info` | Tier 4 | One of `fatal`/`error`/`warn`/`info`/`debug`/`trace`. |
| `DATABASE_URL` | yes | — | **Tier 1** in prod / Tier 4 dev | Postgres connection string. Dev placeholder uses `fleetco:fleetco` per `docker-compose.yml`. Real prod creds in secret store. |
| `REDIS_URL` | yes | — | **Tier 1** in prod / Tier 4 dev | Redis connection string. Dev placeholder hits the compose service. |

Conventions:

- `.env.example` is the committed canonical default. Copy to `.env` (gitignored) for local overrides such as port collisions with sibling projects.
- Tier 1 values never appear in any committed file. The pino redact list in [`src/app.module.ts`](./src/app.module.ts) covers Tier 1 / Tier 2 PII patterns at the log layer.

## Conventions

- **Modules.** Each `src/modules/<name>/` directory owns its tables (via Prisma), its service interface (the only public surface), and its event emitters. Cross-module imports of internal files are forbidden per CLAUDE.md and ADR-0001; only the service interface is public.
- **Migrations.** Versioned and append-only. Never edit an applied migration. Never use `prisma db push` outside local exploration. Schema changes produce new migrations via `pnpm --filter @fleetco/api db:migrate`.
- **Logging.** `nestjs-pino` provides a request-scoped logger with `x-request-id` propagation. Redact list at module config. See ADR-0018.
- **Errors.** Unhandled throws reach Sentry when `SENTRY_DSN` is set. The `beforeSend` hook for Tier 2/3 stripping lands when the first user-attributable error paths appear (per ADR-0018's named gap).
