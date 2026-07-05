import path from "node:path";

import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Transpile the workspace package's TypeScript source. The web consumes
  // @fleetco/shared as TS source (its `main` points at src/index.ts), and Next
  // does NOT transpile node_modules — including symlinked workspace deps —
  // unless they are listed here. The shared compliance/BS-date helpers
  // (ADR-0038 commitment 6) are re-exported through `@/lib/compliance` and
  // `@/lib/nepali-date`, so without this the SSR build would fail to parse the
  // shared `.ts`. Verified by the SSR `next build` gate.
  transpilePackages: ["@fleetco/shared"],
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
  experimental: {
    serverActions: {
      // The chat photo upload rides a server action as FormData (ADR-0044
      // V5); Next's default 1 MB body cap would reject it. 12 MB = the API's
      // 10 MB attachment ceiling plus multipart overhead — the API remains
      // the real enforcement point.
      bodySizeLimit: "12mb",
    },
  },
};

export default nextConfig;
