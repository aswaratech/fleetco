# dev-setup

> **STATUS: ACTIVE.** First draft. The procedure here covers fresh-machine setup through "the API can talk to Postgres and Redis, and the web is running." Ticket 13 of the kickoff plan extends this draft with web smoke tests, browser checks, and platform-specific troubleshooting.

## When this procedure applies

Setting up a fresh machine to do FleetCo development. The procedure terminates when:

- the API is running locally and responding to `GET /health` with `{"ok":true}` and to `GET /health/ready` with `{"ok":true,"db":"up","redis":"up"}`, and
- the admin web is running locally and the browser shows the placeholder `/login` page.

The procedure assumes a Unix-shell environment (macOS or Linux). Windows contributors are expected to use WSL2; differences are not yet documented (Ticket 13 will note them when a Windows contributor first runs this procedure).

## Prerequisites

Pin these versions to match `package.json` `engines` and the CI image (Ticket 11). Older versions may work but are not what the project tests against.

| Tool | Version | Why |
|---|---|---|
| Node.js | `>=24.0.0 <25.0.0` | Workspace `engines.node`. Use `nvm install 24` or equivalent. |
| pnpm | `>=10.0.0 <11.0.0` | Workspace `engines.pnpm`. `corepack enable && corepack prepare pnpm@10 --activate`. |
| Docker | `>=24` with Compose v2 | Runs the local Postgres + Redis containers. Docker Desktop on macOS includes Compose. |
| git | any modern | Repository access. |
| gh (GitHub CLI) | any modern | Optional; useful for PR work but not required to run the API locally. |
| psql | any | Optional; useful for ad-hoc DB inspection. Comes with Postgres client tools (`brew install libpq` on macOS, then add to PATH). |

## Procedure

```bash
# 1. Clone the repository.
git clone git@github.com:addressanup/fleetco.git
cd fleetco

# 2. Install dependencies.
pnpm install

# 3. Create local environment files (both are gitignored).
cp apps/api/.env.example apps/api/.env
cp apps/web/.env.example apps/web/.env

# 4. Bring up the data plane.
docker compose up -d

# 5. Verify both services are healthy. Both rows should show "(healthy)".
docker compose ps

# 6. Apply migrations to the local Postgres. Creates the PostGIS extension
#    AND the auth tables (user/session/account/verification) from Ticket 10.
pnpm --filter @fleetco/api prisma migrate dev

# 7. Generate a session secret and append it (plus admin credentials) to
#    apps/api/.env. Tier 1 + Tier 2 values — never commit.
pnpm --filter @fleetco/api run auth:secret
# Paste the output into apps/api/.env as BETTER_AUTH_SECRET=...
# Also set in apps/api/.env:
#   BETTER_AUTH_URL=http://localhost:3001     (or your PORT override)
#   CORS_ORIGIN=http://localhost:3000
#   ADMIN_EMAIL=admin@fleetco.local
#   ADMIN_PASSWORD=<a memorable dev password>

# 8. Seed the single admin user. Idempotent — re-running reports
#    "already exists" without modification.
pnpm --filter @fleetco/api db:seed
# Expected: "Created admin admin@fleetco.local (id=...)"

# 9. Boot the API. Leave this terminal running.
pnpm --filter @fleetco/api dev
# Expected: log line "FleetCo API listening on http://localhost:3001"
```

In a second terminal:

```bash
# 10. Liveness check. Should return {"ok":true} with HTTP 200.
curl -s -w '\nHTTP %{http_code}\n' http://localhost:3001/health

# 11. Readiness check. Should return {"ok":true,"db":"up","redis":"up"} with HTTP 200.
curl -s -w '\nHTTP %{http_code}\n' http://localhost:3001/health/ready

# 12. Auth smoke test. /me without a cookie returns 401; signing in returns
#     200 + Set-Cookie; /me with the cookie returns 200 + admin email.
curl -s -w '\nHTTP %{http_code}\n' http://localhost:3001/me
# Expected: {"message":"Unauthorized","statusCode":401}  HTTP 401

curl -s -i -X POST http://localhost:3001/auth/sign-in/email \
  -H 'Content-Type: application/json' \
  -H 'Origin: http://localhost:3000' \
  -d '{"email":"admin@fleetco.local","password":"<your dev password>"}'
# Expected: HTTP 200, Set-Cookie: better-auth.session_token=<value>; HttpOnly; ...

# Use the cookie value from the previous response:
COOKIE='better-auth.session_token=<paste here>'
curl -s -w '\nHTTP %{http_code}\n' http://localhost:3001/me -H "Cookie: $COOKIE"
# Expected: {"id":"...","email":"admin@fleetco.local"}  HTTP 200

curl -s -i -X POST http://localhost:3001/auth/sign-out \
  -H "Cookie: $COOKIE" \
  -H 'Origin: http://localhost:3000' \
  -H 'Content-Type: application/json'
# Expected: HTTP 200, Set-Cookie: better-auth.session_token=; Max-Age=0 (cleared)

# 13. Boot the admin web. Leave this terminal running.
pnpm --filter @fleetco/web dev
# Expected: log line "▲ Next.js ... ready" with port 3000

# 14. In a browser, open:
#       http://localhost:3000
#     Expected: redirect to /login; the wired sign-in form renders.
#     Sign in with admin credentials → home page shows "Signed in as
#     admin@fleetco.local". Click Sign out → back to /login.
```

## Running API tests locally

The API test suite runs against a real Postgres database named `fleetco_test` (separate from the `fleetco` dev database). The schema is brought up once per `pnpm --filter @fleetco/api test` invocation by a Vitest global setup that runs `prisma migrate deploy`; each test resets the data with `TRUNCATE ... RESTART IDENTITY CASCADE`. See ADR-0023 for the rationale.

```bash
# 1. Create the test database on the local Postgres. One-time per machine.
#    The compose Postgres user is a superuser, so CREATE DATABASE works.
docker compose exec postgres psql -U fleetco -d fleetco -c "CREATE DATABASE fleetco_test;"

# 2. Copy the test env template. The default targets host port 5432; if you
#    overrode POSTGRES_PORT (see "Port 5432 already in use" below), edit
#    apps/api/.env.test to match. .env.test is gitignored.
cp apps/api/.env.test.example apps/api/.env.test
# If POSTGRES_PORT=55432, change the DATABASE_URL host port in apps/api/.env.test.

# 3. Run the suite. ~2-3 seconds on a warm machine; under the 30s budget per
#    ADR-0023 §5 so it can join the pre-commit gate list.
pnpm --filter @fleetco/api test
# Expected: "Test Files 4 passed (4)  Tests N passed (N)" in 2-3s.
```

The full pre-commit gate is now:

```bash
pnpm format && pnpm format:check && pnpm lint && pnpm typecheck && pnpm --filter @fleetco/api test
```

CI runs the same suite against a `postgis/postgis:16-3.5` service container; see `.github/workflows/ci.yml`'s `services: postgres` block.

## What can go wrong

### Port 5432 (Postgres) is already in use

Likely a sibling project (another Docker compose stack), a host Postgres installed via Homebrew, or another tool. Identify the holder:

```bash
lsof -nP -iTCP:5432 -sTCP:LISTEN
docker ps --format '{{.Names}}\t{{.Ports}}' | grep 5432
```

Resolution paths, in order of preference:

1. **Stop the conflicting service** if you do not need it during this FleetCo session. For Homebrew Postgres: `brew services stop postgresql`. For a sibling Docker project: `(cd ../sibling-project && docker compose stop)`.
2. **Override the FleetCo host port.** Create `.env` at the repo root (gitignored) with `POSTGRES_PORT=55432` (or any free port). Then update `apps/api/.env`'s `DATABASE_URL` host port to match (e.g. `postgresql://fleetco:fleetco@localhost:55432/fleetco?schema=public`). Re-run `docker compose down && docker compose up -d`. The compose file's `${POSTGRES_PORT:-5432}:5432` substitution picks up the override.

### Port 6379 (Redis) is already in use

Same shape as Postgres above. Override variable is `REDIS_PORT` in the repo-root `.env`. Update `apps/api/.env`'s `REDIS_URL` host port to match.

### Port 3001 (API) is already in use

A sibling NestJS or Node project. Override `PORT` in `apps/api/.env` to a free port (e.g. `3011`). The API picks it up on next `pnpm --filter @fleetco/api dev`. There is no client of the API yet that hardcodes 3001, so the override is local-only.

### `prisma migrate dev` fails with `ECONNREFUSED`

The Postgres healthcheck has not gone green yet, or Postgres is not running. Check:

```bash
docker compose ps              # is postgres "(healthy)"?
docker compose logs postgres   # any errors?
```

Wait 5-10 seconds after `docker compose up -d` for the healthcheck to register, then retry.

### `prisma migrate dev` reports `permission denied to create extension "postgis"`

The connecting user must be a Postgres superuser to create extensions. The compose file uses `POSTGRES_USER=fleetco`, which the Postgres image creates as a superuser by default. If you changed `POSTGRES_USER` to something else, or you are connecting to a non-compose-managed Postgres, ensure the user has the `SUPERUSER` role or a role that can `CREATE EXTENSION postgis`.

### `prisma migrate dev` reports "Drift detected" listing PostGIS extensions

This should not happen with the committed `docker-compose.yml` because the image's auto-enable init script is overridden with a no-op (see `docker/postgres-init/disable-auto-extensions.sh` and ADR-0020). If you see drift on extensions, the override mount is not in effect — likely cause: you started Postgres from a different compose file, or the bind-mount path is unreadable.

Fix: `docker compose down -v` to wipe the data volume, then `docker compose up -d` so the (correct) init scripts re-run with the override in place.

### `pnpm install` flags "Ignored build scripts"

pnpm 10 quarantines build scripts by default. The root `package.json`'s `pnpm.onlyBuiltDependencies` list pre-approves the packages this project needs to run postinstall scripts (`@prisma/client`, `@prisma/engines`, `@nestjs/core`, `esbuild`, `prisma`, `sharp`). If a new dependency lands that needs its build script, add it to that list in the same PR that adds the dependency.

### `pnpm --filter @fleetco/api dev` exits with "Invalid environment configuration"

`apps/api/.env` is missing or has a malformed value. The zod schema in `apps/api/src/config/env.ts` validates at startup. Common cases:

- **`DATABASE_URL: Invalid input: expected string, received undefined`** — you skipped step 3 (`cp apps/api/.env.example apps/api/.env`).
- **`SENTRY_DSN: Invalid URL`** — you set `SENTRY_DSN` to a non-URL value. Either leave it empty (`SENTRY_DSN=`) or set a real Sentry DSN.
- **`DATABASE_URL: Invalid URL`** — the connection string has a typo. Format is `postgresql://USER:PASSWORD@HOST:PORT/DATABASE?schema=public`.

### `docker compose down -v` lost all my data

Expected. `-v` removes the named volumes (`postgres_data`, `redis_data`). Re-run `docker compose up -d && pnpm --filter @fleetco/api prisma migrate dev && pnpm --filter @fleetco/api db:seed` to start fresh.

### Sign-in returns 200 but the browser cookie does not stick

The most common cause is a CORS mismatch. The browser will only honor a cross-origin `Set-Cookie` when (a) the response has `Access-Control-Allow-Credentials: true` AND (b) the request was made with `credentials: "include"` (better-auth's React client does this by default). Check:

- `apps/api/.env`'s `CORS_ORIGIN` must include the browser's origin (e.g. `http://localhost:3000`).
- `apps/api/.env`'s `BETTER_AUTH_URL` must match the API's actual listening URL (including the port — if you overrode `PORT` to 3011, this is `http://localhost:3011`).
- `apps/web/.env`'s `NEXT_PUBLIC_API_URL` must point at the same API URL.

Inspect the browser DevTools Network tab: the `POST /auth/sign-in/email` response should carry `Set-Cookie: better-auth.session_token=...; HttpOnly` AND a CORS allow-credentials header. If `Access-Control-Allow-Origin` is `*`, credentials are silently dropped.

### `curl` sign-out returns 403 `MISSING_OR_NULL_ORIGIN`

better-auth's origin check (CSRF protection) requires an `Origin` header on state-changing routes (sign-out, password change, etc.). Browsers send this automatically. For manual `curl` testing, pass `-H 'Origin: http://localhost:3000'` (or any origin listed in `CORS_ORIGIN`).

### `db:seed` reports "ADMIN_EMAIL and ADMIN_PASSWORD must be set"

The seed script reads `ADMIN_EMAIL` (Tier 2 PII) and `ADMIN_PASSWORD` (Tier 1 credential) from `apps/api/.env`. Both must be present. The schema in `apps/api/src/config/env.ts` makes them optional at API boot (so the API can run without them) and the seed script enforces their presence at run time.

### API boot fails with `SyntaxError: ... does not provide an export named 'kAPIErrorHeaderSymbol'`

A `better-call` peer-dep mismatch — typically caused by a transitive resolution pulling the older `1.1.x` line that an outdated tool (e.g. an `@better-auth/cli` major behind `better-auth`) depends on. Resolution: remove the outdated tool (`pnpm --filter @fleetco/api remove <tool>`), or pin the tool to a version that matches `better-auth`'s `better-call@1.3.x` peer.

### Containers came back unhealthy after macOS restart

Docker Desktop sometimes leaves containers in a confused state across a host restart. `docker compose down && docker compose up -d` reliably restores them.

## Last verified

- **2026-05-21** — initial draft; verified on macOS (Apple Silicon) running Docker Desktop with sibling-Docker projects on the canonical ports (port overrides documented above were used). Postgres came up via `imresamu/postgis:16-3.5`; Redis via `redis:7-alpine`; `prisma migrate dev` applied the baseline migration creating the PostGIS extension; both health endpoints returned the expected JSON; the readiness probe correctly transitioned to 503 when the redis container was stopped and back to 200 when it was started.
- **2026-05-21** (session 11) — extended with the auth-flow procedure for Ticket 10. The full smoke test (admin seed → `/me` 401 → sign-in 200 + cookie → `/me` 200 → sign-out → `/me` 401) passed against the same machine with `PORT=3011`, `POSTGRES_PORT=55432`, `REDIS_PORT=56379` overrides. The web dev server on `:3000` correctly redirected unauthenticated `/` to `/login` and, after sign-in, rendered the gated home with the admin's email.
- **2026-05-26** (iter 5) — extended with the "Running API tests locally" section as part of the API test framework discharge (ADR-0023). The full suite (39 tests across `auth.guard`, `health.controller`, `vehicles.service`, `vehicles.controller`) ran in ~2.2s on the same machine with the `POSTGRES_PORT=55432` override; `fleetco_test` was created via the documented one-time `CREATE DATABASE` and `apps/api/.env.test` overrode the host port to 55432 to match.
