# FleetCo Driver (mobile)

The driver-facing mobile app — Expo / React Native, Android-first. A **standalone
sub-project outside the pnpm workspace** per **ADR-0033** (own lockfile, installed
with `--ignore-workspace`).

## Status

**D0–D3 (+B2) shipped.** Toolchain spike + CI gate (D0); better-auth login via
`@better-auth/expo` (D1); the DRIVER role's own-record scope + a trip start/stop
screen (D2); and odometer + fuel entry (D3, meter-aware B2) — so login, an
own-trip list, trip start/stop, and fuel/odometer entry all work. Still to come:
GPS capture — the foreground producer + offline outbox (D4–D6, ADR-0035) — and a
device-build path (EAS / local prebuild) beyond Expo Go. The app is a pure
consumer of the FleetCo API, so it delivers field value only once that API is
deployed.

## Run it (dev)

This package is **not** a workspace member; install with `--ignore-workspace`:

```sh
cd apps-mobile/driver
pnpm install --ignore-workspace
pnpm start          # then scan the QR code with Expo Go on an Android phone
```

The device-build path (EAS / local prebuild) is **deferred** per ADR-0033 — Expo
Go is the D0–D3 on-device runtime. See `docs/runbook/dev-setup.md`.

## Checks (what the mobile CI job runs)

```sh
pnpm typecheck      # tsc --noEmit
pnpm lint           # eslint (eslint-config-expo)
pnpm test           # jest-expo
```
