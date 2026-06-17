# syntax=docker/dockerfile:1
###############################################################################
# FleetCo API — production image (ADR-0014 §7).
#
# Build context is the REPO ROOT (this is a pnpm-workspace member), e.g.:
#   docker build -f apps/api/Dockerfile -t fleetco-api .
#
# The runtime stage can run THREE commands — this resolves the unverified
# assumption flagged in docs/runbook/deploy.md ("the production api image must
# carry the migrate + seed tooling"):
#   1. node dist/main.js                                       (the API server)
#   2. pnpm --filter @fleetco/api exec prisma migrate deploy   (idempotent DDL)
#   3. pnpm --filter @fleetco/api db:seed                      (one-off admin seed)
#
# To satisfy (2) and (3) the runtime carries the Prisma CLI + prisma/ (schema +
# migrations) AND tsx + the seed's TypeScript sources (deploy.md option (a)).
# That intentionally keeps the api dev toolchain in the image; trimming to a
# prod-only tree with a separately-pinned Prisma CLI + tsx is a future size
# optimization, not a correctness requirement, and is out of scope for T1.
#
# The base image is pinned to Node 24 (matching .nvmrc / package.json engines).
###############################################################################

ARG NODE_IMAGE=node:24-bookworm-slim

# --- base: Node + pnpm (pinned via package.json packageManager) --------------
FROM ${NODE_IMAGE} AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
# openssl is required by the Prisma query engine on debian-slim. ca-certificates
# lets prisma generate fetch engines and the app reach TLS endpoints.
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*
RUN corepack enable && corepack prepare pnpm@10.33.3 --activate
WORKDIR /app

# --- deps: install the api + its workspace deps (incl. dev: prisma, tsx, nest)
FROM base AS deps
# Manifests + lockfile first for cache-friendly layers. All workspace manifests
# are copied so --frozen-lockfile can validate the workspace against the
# lockfile; the --filter then restricts the actual install to api (+ shared).
# .npmrc carries pnpm settings the lockfile was resolved under (engine-strict,
# auto-install-peers); tsconfig.base.json is what apps/api/tsconfig.json extends
# (the build's esModuleInterop/strict options live there).
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json .npmrc tsconfig.base.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
RUN pnpm install --frozen-lockfile --filter "@fleetco/api..."

# --- build: generate the Prisma client + compile NestJS to dist/ -------------
FROM deps AS build
COPY packages/shared packages/shared
COPY apps/api apps/api
RUN pnpm --filter @fleetco/api exec prisma generate
RUN pnpm --filter @fleetco/api build

# --- runtime -----------------------------------------------------------------
FROM base AS runtime
ENV NODE_ENV=production
# The NestJS API listens on PORT (env.ts default 3001); Caddy reverse-proxies
# /api/* /auth/* /health* here (ADR-0014 §2).
ENV PORT=3001
# Bring the whole built workspace across so the pnpm symlink layout stays
# intact: this is what lets `pnpm --filter @fleetco/api ...` resolve at runtime
# for the migrate + seed commands, and keeps node_modules/.bin/{prisma,tsx}
# working. The build context excluded node_modules/dist/.env via .dockerignore.
COPY --from=build /app /app
WORKDIR /app/apps/api
EXPOSE 3001
# Default command: the API server. The deploy runbook overrides the command for
# the one-off migrate + seed Compose tasks (see docs/runbook/deploy.md).
CMD ["node", "dist/main.js"]
