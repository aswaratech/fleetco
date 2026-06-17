# syntax=docker/dockerfile:1
###############################################################################
# FleetCo web admin — production image (ADR-0014 §7).
#
# Build context is the REPO ROOT (this is a pnpm-workspace member), e.g.:
#   docker build -f apps/web/Dockerfile -t fleetco-web .
#
# Uses Next.js `output: 'standalone'` (apps/web/next.config.ts): `next build`
# emits a self-contained .next/standalone/ tree (a minimal server.js + the
# traced node_modules subset, with @fleetco/shared bundled in), so the runtime
# image needs neither the full dependency tree nor `next start`.
#
# The browser reaches the web app same-origin via Caddy, which serves it and
# reverse-proxies /api/* /auth/* /health* to the api container (ADR-0014 §2).
#
# The base image is pinned to Node 24 (matching .nvmrc / package.json engines).
###############################################################################

ARG NODE_IMAGE=node:24-bookworm-slim

# --- base: Node + pnpm (pinned via package.json packageManager) --------------
FROM ${NODE_IMAGE} AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable && corepack prepare pnpm@10.33.3 --activate
WORKDIR /app

# --- deps: install the web + its workspace deps (incl. dev: tailwind, types) -
FROM base AS deps
# All workspace manifests are copied so --frozen-lockfile can validate the
# workspace; the --filter restricts the actual install to web (+ shared).
# .npmrc carries pnpm settings the lockfile was resolved under; tsconfig.base.json
# is what apps/web/tsconfig.json extends (strict/compiler options live there).
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json .npmrc tsconfig.base.json ./
COPY apps/web/package.json apps/web/
COPY apps/api/package.json apps/api/
COPY packages/shared/package.json packages/shared/
RUN pnpm install --frozen-lockfile --filter "@fleetco/web..."

# --- build: next build -> .next/standalone -----------------------------------
FROM deps AS build
ENV NEXT_TELEMETRY_DISABLED=1
# Next.js inlines NEXT_PUBLIC_* values at BUILD time (not runtime). The default
# matches the code's own fallback (apps/web/src/lib/api.ts), so an un-passed arg
# behaves identically to today; the T3 push build will pass the real public
# origin via --build-arg NEXT_PUBLIC_API_URL=https://<domain>.
ARG NEXT_PUBLIC_API_URL=http://localhost:3001
ENV NEXT_PUBLIC_API_URL=${NEXT_PUBLIC_API_URL}
COPY packages/shared packages/shared
COPY apps/web apps/web
RUN pnpm --filter @fleetco/web build

# --- runtime: run the standalone server as a non-root user -------------------
FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
# Next's standalone server reads PORT + HOSTNAME from the environment.
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
WORKDIR /app
RUN groupadd --system --gid 1001 nodejs \
  && useradd --system --uid 1001 --gid nodejs nextjs

# The standalone tree (server.js + traced node_modules) is laid out from the
# monorepo root (outputFileTracingRoot), so its server entrypoint is at
# apps/web/server.js. Static assets and (if present) public/ are NOT part of
# standalone and must be copied alongside it.
COPY --from=build --chown=nextjs:nodejs /app/apps/web/.next/standalone ./
COPY --from=build --chown=nextjs:nodejs /app/apps/web/.next/static ./apps/web/.next/static

USER nextjs
EXPOSE 3000
CMD ["node", "apps/web/server.js"]
