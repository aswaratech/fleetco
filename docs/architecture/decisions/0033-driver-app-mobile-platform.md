# ADR-0033: Driver-app mobile platform — Expo (managed + CNG) on a standalone sub-project, a deterministic network-free CI gate run in a separate loop program, and a deferred device-build path

- **Status:** Accepted
- **Date:** 2026-06-06
- **Decider:** Product owner (CEO)
- **Accepted:** 2026-06-09

## Acceptance

Accepted by the product owner (CEO) on 2026-06-09. The two owner-level picks this ADR carried are ratified: the driver app is a **standalone sub-project** at `apps-mobile/driver/` (outside the pnpm workspace), and the **device-build/binary path is deferred** — Expo Go is the D0–D3 on-device runtime, with the EAS-vs-local-prebuild choice revisited at the D3→D4 boundary. The implementing program (D0 onward) may now proceed; the glossary / `dev-setup.md` / `CURRENT_PHASE.md` updates land with the D0 slice, not here.

## Context

Phase 2 ("Driver app and telematics") is open per ADR-0025. Its headline deliverable — the one user-facing pillar the whole phase is named for — is "a React Native (Expo) driver app for Android first" (`docs/product/roadmap.md` §"Phase 2"). The Phase-2 *backend* is already built but **inert**: RBAC (ADR-0028), the GPS telematics ingestion stack (ADR-0029, T1–T5), and geofence storage (ADR-0030, G1–G5) all ship, but nothing produces data because the producer — the driver app — does not exist. This ADR begins building it.

A mobile app is a **new architectural surface**: a new runtime (React Native, not the NestJS/Next.js the repo holds today), a new top-level dependency set (CLAUDE.md: "propose a new top-level dependency first"), and a build/CI/loop fit unlike the vertical slices the orchestration loop drives. Per CLAUDE.md's "How to work on a task" step 4, a cross-cutting concern plus a new dependency requires PO confirmation **before code**; per the project's pattern (ADR-0021 for auth wiring, ADR-0028 for RBAC, ADR-0029 for ingestion), the confirmation vehicle is an ADR. **This is the first of three driver-app foundation ADRs proposed together** — ADR-0033 (this one: platform, placement, CI), ADR-0034 (mobile auth + the DRIVER role), and ADR-0035 (the offline GPS producer) — designed to be **accepted in order**, each consuming the prior. The split mirrors the 0026/0027/0028 batch-propose precedent: three separable accept/reject decisions, each crossing a different discipline gate (here: build infra; there: auth/RBAC; there: ingestion contract + Tier-5 data), rather than one fused decision.

The substrate constrains the choices, and was verified against the repo:

- **The monorepo** is a pnpm workspace (`pnpm-workspace.yaml` globs `apps/*`); `apps/api` (NestJS) and `apps/web` (Next.js) are its members. `.npmrc` carries **no `node-linker`**, so the workspace runs pnpm's default **isolated (symlinked) linking** — a load-bearing fact below.
- **CI** is a single `ci` job (lint, typecheck, build, test, one `pnpm install --frozen-lockfile`) plus `security.yml` (Dependabot, Semgrep, secrets scanning, action SHA-pinning, CycloneDX SBOM — ADR-0012). "Green" for a PR is that job passing.
- **The orchestration loop (ADR-0022)** opens one PR per ticket, polls `gh pr checks <N>`, **auto-merges on green**, halts without auto-fixing, and refuses to run if `.github/workflows/` has no yml on main. It is downstream of CLAUDE.md, never above it.
- **`scripts/orchestration/`** is the in-repo precedent for a **standalone sub-project**: operator tooling explicitly *not* part of the workspace, installed with `pnpm install --ignore-workspace`, its own `package.json`/lockfile. It is, however, *operator tooling never built in CI* — a difference that matters in commitment 4.

This ADR **decides platform, placement, and CI only**. It writes no app code and adds no dependency to `apps/*`; the mobile dependency set installs inside the standalone sub-project when the first code ticket (D0) lands. The PO has selected the load-bearing picks (placement and the device-build posture) via the planning decisions this ADR records; acceptance ratifies them.

## Decision

**Build the driver app as an Expo SDK 55 (managed workflow + Continuous Native Generation) React Native app, Android-first, living as a standalone sub-project at `apps-mobile/driver/` outside the pnpm workspace (own lockfile, `pnpm install --ignore-workspace`); gate it in CI with a new, deterministic, network-free job (`pnpm install --frozen-lockfile` + `tsc --noEmit` + `eslint` + `jest-expo`) that is a required check, with `expo-doctor`/`expo prebuild`/EAS kept out of the polled gate, and run mobile tickets in a loop program separate from backend tickets; and defer the device-build (binary) path — Expo Go is the D0–D3 on-device runtime, and a custom build becomes a prerequisite only at D4.** Nine commitments define the shape, grouped into the areas the code program needs. As with its siblings, this ADR **writes no code**; the implementing slices build it.

### A. Platform

1. **Expo SDK 55, managed workflow + CNG + config plugins; Android-first.** Use Expo's managed workflow with Continuous Native Generation (the native `android/` project is generated from config + plugins, not hand-maintained) on SDK 55 (React Native 0.83 / React 19.2, New Architecture). Android-first per the roadmap. Expo over bare React Native because CNG's "config is the source of truth, the native directory is disposable regenerated output" mirrors FleetCo's own Prisma-migration philosophy (the schema is truth; you never hand-edit applied output), and bare RN's hand-maintained `android/` plus its upgrade treadmill is the wrong cost for a one-agent team building an internal tool.
2. **Generated native output is disposable; every native dependency must be New-Arch compatible.** The generated `android/` tree is build output: **gitignored, never hand-edited** (the exact discipline of "never edit an applied migration" — a hand-edit is silently overwritten by the next `prebuild`). Every native dependency added from here on must be New-Architecture compatible and is vetted with `expo-doctor` (the mobile analogue of "propose a new dependency first"). Native config lives in `app.json`/`app.config.ts` + config plugins, in version control, where it diffs cleanly (ADR-0009).

### B. Placement

3. **Standalone sub-project at `apps-mobile/driver/`, outside the workspace.** The app has its own `package.json`, lockfile, and `node_modules`, installed with `pnpm install --ignore-workspace`, in a directory *outside* the `apps/*` workspace glob — modeled on the `scripts/orchestration/` precedent. The reason is **build isolation**: React Native's Metro bundler and native autolinking are fragile in a pnpm workspace's symlinked layout, and isolating the mobile toolchain keeps a misstep in it from destabilizing the two shipping apps' installs. **A correction to a stale rationale:** this is *not* "we'd otherwise have to flip the workspace to `node-linker=hoisted`" — Expo SDK 54+ supports pnpm's isolated linking (the very layout the repo already runs), so a workspace-member path now technically exists. It is dispreferred because in-workspace Metro/monorepo resolution remains finicky per-library and not worth the blast radius to two green apps for a one-agent team. **The cost we accept:** the mobile app cannot symlink a shared `@fleetco/*` package, so the small, frozen ping/trip DTO it produces against is **hand-mirrored** rather than imported (recorded as tech-debt; revisit if the shared surface grows — see "Revisit when").

### C. CI and loop fit

4. **A new, deterministic, network-free CI job — and the dependency-integrity it must not skip.** Add a GitHub Actions job (parallel to `ci`) that `cd`s into `apps-mobile/driver/`, runs **`pnpm install --frozen-lockfile`**, then **`tsc --noEmit` + `eslint` (eslint-config-expo) + `jest-expo`**. Three integrity points that follow from standalone placement (commitment 3) and are easy to miss: (a) the standalone lockfile does **not** inherit the workspace's frozen-lockfile gate, so it gets its **own** `--frozen-lockfile` — dependency integrity is non-negotiable per ADR-0012; (b) `apps-mobile/driver/package.json` is added to `.github/dependabot.yml` so the standalone lockfile is not a dependency-update blind spot; (c) `.prettierignore`/eslint ignores are scoped to the mobile tree's generated and config files (`.expo/`, `android/`, metro/babel config) — *or* the mobile job owns its own format check — so the "root `prettier --check .` covers it" claim is made true, not assumed. **`expo-doctor` and `expo prebuild` stay OUT of the polled gate** (both touch the network/registry; a network-dependent check in the loop's polled set is a new source of nondeterministic halts the loop cannot auto-fix) — they run nightly/manually.
5. **The mobile job is a required check, and mobile tickets run in a separate loop program.** The job must be a *required* status check or the gate is theater (the loop declares green only when every check is final-and-passing). Because a required check couples its health to every PR in the same loop run, **mobile and backend tickets do not share a loop program** — a transient mobile-toolchain failure must never halt a backend PR. (Operationally: `rm scripts/orchestration/state.json` between programs, per the loop's per-program reset.)
6. **The loop drives mobile *code* tickets cleanly; the binary is the boundary.** Fast, deterministic, binary-free checks are exactly what `gh pr checks` polling + auto-merge-on-green wants, so D0–D3 (and D6) merge through the loop normally. The hard boundary: a PR-time gate **cannot produce or verify an installable `.apk`/`.aab`** — that needs a build path, and the agent holds no signing credentials, so any binary is operator-led. Keeping binaries out-of-band is precisely what *preserves* the loop's fast green signal (the discipline ADR-0022 protects), and the split is the same one ADR-0025 already accepts for the operator-led production deploy.

### D. Device-build path (deferred)

7. **The device-build path is deferred; Expo Go is the D0–D3 runtime; a custom build is a D4 prerequisite.** The custom build (EAS cloud, or `eas build --local`/local prebuild) is **not adopted now** (the PO's decision). **Expo Go** — the off-the-shelf Expo client — loads the dev project on a real phone via a QR code with **no build and no signing**, for any slice using only Expo-Go-bundled libraries; the scaffold, the bearer-auth login (ADR-0034), and the reused-endpoint screens all qualify, so D0–D3 are demonstrable on a real phone with zero build infrastructure. A custom build becomes a **prerequisite at D4** — the first slice using a library Expo Go does not bundle (`expo-location` background tracking, then ADR-0035's SQLCipher-encrypted store). The **EAS-vs-local-prebuild choice and its operator/cost commitment are revisited at the D3→D4 boundary** (tech-debt). One cross-dependency to state plainly: real field use also needs the **deployed API** (the owed Phase-1 production deploy, ADR-0014/ADR-0025) — D0–D3 demos point Expo Go at a local or tunneled API, but a driver in the field needs the API actually deployed, which makes that owed deploy more pressing, not less.

### E. Build-program shape and boundaries

8. **The driver-app code program (prefix `D`), proposed not executed.** A sketch so the PO sees the path; each slice is vertical, one PR, `main` green, and (per the PO's first-slice decision) the toolchain spike comes before auth:
   - **D0 — Toolchain spike (this ADR).** The standalone Expo SDK 55 scaffold + the network-free CI job (commitment 4) + a no-login "hello" screen; the `docs/CURRENT_PHASE.md` Phase-2 note lands in D0's **first** commit. Proof: it runs in Expo Go on a real phone. Loop-driveable; the operator does the Expo Go smoke.
   - **D1 — Auth + DRIVER role (ADR-0034).** `bearer()` + the `User`↔`Driver` link + login + a `GET /me` screen.
   - **D2 — Trip start/stop + the own-record scope (ADR-0034).** The row-level predicate lands atomically with the `trips:*` grant.
   - **D3 — Odometer + fuel entry.** Reuse `POST /fuel-logs`.
   - **→ Build-path gate before D4** (commitment 7).
   - **D4 — Foreground GPS (ADR-0035).** First producer feeding the inert ADR-0029 backend.
   - **D5 — Background GPS + the encrypted offline outbox (ADR-0035).**
   - **D6 — Geofence-aware on-trip context (ADR-0030 reads, scoped).**
9. **What this ADR does not decide.** It does not decide mobile auth, the bearer token, or the DRIVER role and its scoping (ADR-0034). It does not decide the GPS capture, the offline queue, or on-device encryption (ADR-0035). It does not pin the exact Expo/React-Native patch versions or the EAS-vs-local build choice (the implementing slice and the D4 gate do). It builds no feature — only the platform the features land on.

### Relationship to prior ADRs (what this realizes and consumes)

- **Realizes** the roadmap's Phase-2 driver-app deliverable, under the Phase-2-ahead-of-gate authority of **ADR-0025** (a reader landing on `CURRENT_PHASE.md` alone still sees "Phase 1"; this ADR is the standing citation that the work is in phase).
- **Consumes ADR-0022** (the loop): the mobile job fits its CI-green gate and runs in a separate program (commitment 5).
- **Consumes ADR-0012**: the standalone lockfile gets its own `--frozen-lockfile` and Dependabot ecosystem (commitment 4).
- **Is consumed by ADR-0034 and ADR-0035**, which build on this placement, CI, and the Expo-Go/custom-build boundary (commitments 4, 7).
- **Is the PO-confirmation vehicle** for the new mobile surface + dependency set per CLAUDE.md step 4 — no mobile code is written until this ADR is accepted.
- **On acceptance**, the glossary gains **Expo**, **Expo Go**, **CNG**, **EAS Build**, and **foreground service** pointers, and `docs/runbook/dev-setup.md` gains a "Running the driver app" section — those memory updates land with the implementing slice (D0), not in this proposal.

## Alternatives considered

**Make the app a workspace member (with `node-linker=hoisted` if needed).** The integration-friendly path: shared `tsconfig`, shared types, one install. Rejected as the default (commitment 3). Flipping the workspace to `node-linker=hoisted` is a workspace-*wide* change that risks the two already-green `apps/api`/`apps/web` installs — and it is *unnecessary*, since SDK 54+ supports the isolated linking the repo already runs. But the in-workspace path remains finicky per native library, and the benefit (symlinked shared types) is obtainable more cheaply by hand-mirroring the tiny frozen DTO. Standalone isolates the fragile toolchain; the workspace-member path is the named upgrade if the shared surface ever grows.

**Bare React Native (no Expo).** Rejected (commitment 1): a hand-maintained `android/` project and a manual upgrade treadmill are the wrong cost for a one-agent internal tool. CNG gives the same native reach through config plugins while keeping the native tree disposable.

**Model `apps-mobile/driver/` exactly on `scripts/orchestration/` (a standalone sub-project never touched by CI).** Rejected as a *complete* model (commitment 4). The orchestration loop is operator tooling whose dependency integrity is not CI-enforced; the driver app is a **product deliverable**, so unlike the loop it gets its own `--frozen-lockfile` install, its own Dependabot ecosystem, and explicit lint/format coverage. Standalone *placement* is borrowed; standalone *un-governance* is not.

**Put `expo-doctor` / `expo prebuild` in the polled CI gate as a deeper smoke test.** Rejected (commitment 4): both touch the network (`expo-doctor` resolves the registry; `prebuild` resolves config plugins and native templates), so a transient failure becomes a nondeterministic red the loop cannot auto-fix — it would halt the program on infrastructure noise. They run nightly/manually instead; the polled gate stays `tsc`+`eslint`+`jest-expo`.

**Interleave mobile and backend tickets in one loop program.** Rejected (commitment 5): a required, occasionally-flaky mobile-toolchain check would gate backend PRs in the same run. Separate programs keep a mobile-toolchain hiccup from halting backend work.

**Adopt EAS Build (or a local build path) now, in the foundation.** The PO chose to defer (commitment 7). Expo Go covers D0–D3 on-device with zero build/signing, and the custom build is only forced at D4 (background location, SQLCipher). Deferring avoids standing up an operator build path and its cost before it is needed; the trade is that D4+ on-device behavior is not provable until the path is stood up.

## Consequences

### What this makes easier

D0 arrives with a settled platform (Expo SDK 55, managed/CNG) and a CI gate the loop drives cleanly. Expo Go gives the PO **free on-device demos of D0–D3** — a driver logging in, starting a trip, entering fuel, all visible on a real phone — without any build infrastructure. Standalone placement isolates the fragile mobile toolchain so it cannot destabilize the two shipping apps. ADR-0034 and ADR-0035 land on a known platform with a known CI gate and a known Expo-Go/custom-build boundary.

### What this makes harder

A second lockfile, a second Dependabot ecosystem, and lint-ignore scoping are now standing maintenance. Mobile tickets run as a separate loop program (one more program to launch and reset). The hand-mirrored DTO is a small sync obligation. And a custom build path is owed before D4 — the on-device behavior of the GPS slices is not provable until it exists.

### Costs we accept

- **The hand-mirrored DTO** (vs publishing `@fleetco/shared`). For ~8 frozen fields this is cheaper than the shared-package machinery; it becomes wrong if the shared surface grows (revisit).
- **Deferring the build path means D4+ on-device behavior is unproven in CI** until the path is stood up. The pure offline/sync logic is unit-tested without a device (ADR-0035), but background GPS and the encrypted store are device-real only on a custom build.
- **Standalone forgoes workspace symlinking** of shared code and a single unified install — the deliberate trade for build isolation.

## Revisit when

- **The D3→D4 boundary is reached.** Choose EAS Build vs a local build path, and price the operator/cost commitment that the deferred build (commitment 7) postponed.
- **The shared mobile↔backend type surface grows past a few frozen fields.** Revisit publishing a `@fleetco/shared` package (and with it, possibly workspace membership), superseding the hand-mirror cost (commitment 3).
- **Expo/Metro materially improves pnpm-workspace support**, or a native library the app needs only works hoisted. Revisit standalone vs workspace member.
- **The network-free CI trio proves insufficient** (real defects slip past `tsc`/`eslint`/`jest-expo`). Add device E2E (Detox/Maestro) nightly, out of the loop — not in the polled gate (commitment 4).
- **Acceptance fixes the picks** (placement and the deferred-build posture); if the PO chooses differently, the implementing slice follows and this ADR is annotated.
