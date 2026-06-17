import path from "node:path";

import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Produce a self-contained server bundle for the production Docker image
  // (ADR-0014 §7). `next build` then emits `.next/standalone/` with a minimal
  // `server.js` + a traced node_modules subset, so the runtime image does not
  // need the full dependency tree or `next start`.
  output: "standalone",
  // This app is a pnpm-workspace member, so dependency tracing must start at
  // the monorepo root to follow the symlinked `@fleetco/shared` package and the
  // hoisted node_modules. Without this, the standalone bundle misses workspace
  // deps. `__dirname` is apps/web; two levels up is the repo root.
  outputFileTracingRoot: path.join(__dirname, "../.."),
};

export default nextConfig;
