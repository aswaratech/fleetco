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

# 6. Apply migrations to the local Postgres. Creates the PostGIS extension.
pnpm --filter @fleetco/api prisma migrate dev

# 7. Boot the API. Leave this terminal running.
pnpm --filter @fleetco/api dev
# Expected: log line "FleetCo API listening on http://localhost:3001"
```

In a second terminal:

```bash
# 8. Liveness check. Should return {"ok":true} with HTTP 200.
curl -s -w '\nHTTP %{http_code}\n' http://localhost:3001/health

# 9. Readiness check. Should return {"ok":true,"db":"up","redis":"up"} with HTTP 200.
curl -s -w '\nHTTP %{http_code}\n' http://localhost:3001/health/ready

# 10. Boot the admin web. Leave this terminal running.
pnpm --filter @fleetco/web dev
# Expected: log line "▲ Next.js ... ready" with port 3000

# 11. In a browser, open:
#       http://localhost:3000
#     Expected: 307 redirect to /login; placeholder Sign-in page renders.
```

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

Expected. `-v` removes the named volumes (`postgres_data`, `redis_data`). Re-run `docker compose up -d && pnpm --filter @fleetco/api prisma migrate dev` to start fresh.

### Containers came back unhealthy after macOS restart

Docker Desktop sometimes leaves containers in a confused state across a host restart. `docker compose down && docker compose up -d` reliably restores them.

## Last verified

- **2026-05-21** — initial draft; verified on macOS (Apple Silicon) running Docker Desktop with sibling-Docker projects on the canonical ports (port overrides documented above were used). Postgres came up via `imresamu/postgis:16-3.5`; Redis via `redis:7-alpine`; `prisma migrate dev` applied the baseline migration creating the PostGIS extension; both health endpoints returned the expected JSON; the readiness probe correctly transitioned to 503 when the redis container was stopped and back to 200 when it was started.
