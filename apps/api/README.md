# `@fleetco/api`

The FleetCo backend. NestJS 11 modular monolith per ADR-0001; the framework + observability stack is in ADR-0018; the data-plane stack (Prisma + Postgres+PostGIS + Redis) is in ADR-0020; the authentication library is in ADR-0015 and the integration shape in ADR-0021. Phase 0 endpoints: `/health`, `/health/ready`, `/auth/*` (better-auth), `/me`. Phase 1 vertical slices live under `src/modules/<name>/` per ADR-0006.

## Local development

The full from-fresh-machine procedure is in [`docs/runbook/dev-setup.md`](../../docs/runbook/dev-setup.md). The short form:

```bash
# from the repo root
docker compose up -d
cp apps/api/.env.example apps/api/.env
# generate a fresh session secret and paste into apps/api/.env
pnpm --filter @fleetco/api run auth:secret
pnpm install
pnpm --filter @fleetco/api prisma migrate dev
pnpm --filter @fleetco/api db:seed
pnpm --filter @fleetco/api dev
```

The API listens on `http://localhost:${PORT:-3001}`.

## Prisma location

Prisma's schema, migrations, and generated client all live under `apps/api/prisma/`. The Prisma CLI is invoked via `pnpm --filter @fleetco/api db:migrate` / `db:generate` / `db:studio` / `db:seed` (see `package.json` scripts).

Rationale: the API is Phase 0's only Prisma consumer, so coupling Prisma to the consumer is the least friction. When a second consumer appears — most likely a driver app in Phase 2 or a dedicated jobs runner — Prisma can extract to `packages/db/` with one of: a `pnpm` workspace move, a re-export of the generated client, and a small change to the `--schema` flag in CLI invocations. The forward-compatibility of this layout is named in ADR-0020.

The first real tables (`user`, `session`, `account`, `verification`) are owned by the auth module and were added in Ticket 10 alongside ADR-0021.

## Health endpoints

| Endpoint | Status code | Body | Purpose |
|---|---|---|---|
| `GET /health` | 200 | `{"ok":true}` | Liveness. The canonical SLI probe target per ADR-0011. Must stay cheap — no dependency checks. |
| `GET /health/ready` | 200 or 503 | `{"ok":boolean,"db":"up"\|"down","redis":"up"\|"down"}` | Readiness. Probes Postgres (via `SELECT 1`) and Redis (via `PING`) in parallel. 200 if both up, 503 if either down. For orchestrators (eventual deploy ADR-0014) and CI integration tests. |

The split keeps `/health` cheap for the SLI surface and lets `/health/ready` exercise the dependency graph honestly without changing the contract that ADR-0011 names. The probe does not exercise auth-module internals (Tier-isolation: a degraded auth schema must not cascade into the readiness signal).

## Authentication

better-auth is mounted at `/auth/*` by `apps/api/src/main.ts` via `toNodeHandler` (Express 5 wildcard syntax: `/auth/{*splat}`). The handler runs before NestJS's body parsers (which are re-attached for non-`/auth` routes). The auth module at `apps/api/src/modules/auth/` owns the Prisma factory provider that constructs the singleton `betterAuth({...})` instance with the global `PrismaService` injected. See ADR-0021 for the full integration shape.

| Endpoint | Source | Purpose |
|---|---|---|
| `POST /auth/sign-in/email` | better-auth | Email + password sign-in. Sets an `httpOnly` `better-auth.session_token` cookie. |
| `POST /auth/sign-out` | better-auth | Clears the session cookie. Requires an `Origin` header in `trustedOrigins` (browsers send this automatically; curl must set `-H 'Origin: http://localhost:3000'`). |
| `GET /auth/get-session` | better-auth | Returns the current `{ user, session }` or HTTP 200 with `null` body when no session. Used by `apps/web/src/lib/session.ts` for server-side gating. |
| `GET /me` | FleetCo (`AuthController`) | Returns `{ id, email }` of the current admin. HTTP 401 when no session. Demonstrates the `@UseGuards(AuthGuard)` pattern that Phase 1 modules will copy. |

The `AuthGuard` at `apps/api/src/modules/auth/auth.guard.ts` is the only export other modules consume (per ADR-0001's "public interface only" rule). Attach via `@UseGuards(AuthGuard)`; the guard either attaches the session to `req.session` and returns true, or throws `UnauthorizedException` (HTTP 401).

The single admin is seeded by `pnpm --filter @fleetco/api db:seed` (script at `apps/api/scripts/seed-admin.ts`). The script is idempotent — running it twice does not duplicate the admin. Run once during local setup; production seeding is named by the deployment ADR (ADR-0014, reserved).

## Environment variables

Validated by [zod](./src/config/env.ts) at module load. Required vars throw a startup error if missing; `.env` is loaded via `dotenv` before validation. The full list:

| Variable | Required | Default | Tier (ADR-0013) | Notes |
|---|---|---|---|---|
| `NODE_ENV` | no | `development` | Tier 4 | One of `development` / `production` / `test`. |
| `PORT` | no | `3001` | Tier 4 | Override locally (e.g. `3011`) when a sibling project holds the default. |
| `SENTRY_DSN` | no | (none) | **Tier 1** | When unset, Sentry init no-ops. Production value lives in the secret store. |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | no | (none) | Tier 4 | ADR-0024. Full OTLP/HTTP traces URL (e.g. `https://collector.example.com/v1/traces`). When unset (the Phase-1 default), no OTLP exporter is built. Backend + sampling policy are chosen in Phase 2. |
| `LOG_LEVEL` | no | `info` | Tier 4 | One of `fatal`/`error`/`warn`/`info`/`debug`/`trace`. |
| `DATABASE_URL` | yes | — | **Tier 1** in prod / Tier 4 dev | Postgres connection string. Dev placeholder uses `fleetco:fleetco` per `docker-compose.yml`. Real prod creds in secret store. |
| `REDIS_URL` | yes | — | **Tier 1** in prod / Tier 4 dev | Redis connection string. Dev placeholder hits the compose service. |
| `BETTER_AUTH_SECRET` | yes | — | **Tier 1** | Session-signing secret. Min 32 bytes. Generate via `pnpm --filter @fleetco/api run auth:secret`. Production value in the secret store. |
| `BETTER_AUTH_URL` | yes | — | Tier 4 | The API's own public URL (e.g. `http://localhost:3011`). Used by better-auth for cookie scoping. |
| `CORS_ORIGIN` | no | `http://localhost:3000` | Tier 4 | Comma-separated allowlist of web origins. Mirrored as better-auth `trustedOrigins`. |
| `ADMIN_EMAIL` | no at API boot | — | **Tier 2** PII | Required only when `db:seed` runs. The founder's email. |
| `ADMIN_PASSWORD` | no at API boot | — | **Tier 1** | Required only when `db:seed` runs. Min 8 chars. The founder's credential. Never logged. |

Conventions:

- `.env.example` is the committed canonical default. Copy to `.env` (gitignored) for local overrides such as port collisions with sibling projects.
- Tier 1 values never appear in any committed file. The pino redact denylist in [`src/observability/log-redact.ts`](./src/observability/log-redact.ts) covers Tier 1 (`*.password`, `*.token`, `*.secret`) and Tier 2 (`*.email`, `*.fullName`, `*.phone`, `*.licenseNumber`, `*.contactPerson`, `*.dateOfBirth`) patterns at the log layer.

## Conventions

- **Modules.** Each `src/modules/<name>/` directory owns its tables (via Prisma), its service interface (the only public surface), and its event emitters. Cross-module imports of internal files are forbidden per CLAUDE.md and ADR-0001; only the service interface is public. The auth module exports the `AUTH` token and `AuthGuard` class.
- **Migrations.** Versioned and append-only. Never edit an applied migration. Never use `prisma db push` outside local exploration. Schema changes produce new migrations via `pnpm --filter @fleetco/api db:migrate`.
- **Logging.** `nestjs-pino` provides a request-scoped logger with `x-request-id` propagation (`genReqId`). When an OpenTelemetry span is active, each log line also carries `trace_id` / `span_id` via a pino `mixin` (ADR-0024); these complement, not replace, the request id. Redact list at module config. See ADR-0018 and ADR-0024.
- **Tracing.** Sentry v9 owns the global OpenTelemetry `TracerProvider`; the API extends that setup rather than standing up a second `NodeSDK` (ADR-0024). HTTP, Prisma, and Redis are auto-instrumented by Sentry's default integrations — nothing is registered for them by hand. Setting `OTEL_EXPORTER_OTLP_ENDPOINT` adds an env-gated OTLP/HTTP span exporter (`buildOtlpSpanProcessors` in `src/observability/otel.ts`); unset — the Phase-1 default — it no-ops. The tracing backend, sampling policy, and span-attribute scrubbing are a Phase-2 decision (see ADR-0024 "Revisit when").
- **Errors.** Unhandled throws reach Sentry when `SENTRY_DSN` is set. The `beforeSend` hook for Tier 2/3 stripping lands when the first user-attributable error paths appear (per ADR-0018's named gap).
- **Bootstrap order in `main.ts`.** `bodyParser: false` at NestJS construction → mount better-auth at `/auth/{*splat}` → re-attach `useBodyParser("json")` and `useBodyParser("urlencoded", { extended: true })` → `enableCors({ origin, credentials: true })` → `listen(PORT)`. Each step matters; see ADR-0021's "Consequences — Harder" section before refactoring.
