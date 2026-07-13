# driver-app-dispatch-e2e

> **STATUS: DRAFT — authored 2026-07-13, NOT yet executed on-device.** This is the
> intended procedure, not proven truth. Unlike the D4/D5 GPS E2E in `dev-setup.md`
> (which is "executed truth"), the ADR-0047 dispatch flow (W7/W8) and the ADR-0035
> D6 arrival indicator have only been **unit-tested with MapLibre stubbed** — the
> map render, the Navigate deep-link, the route-preview line, and the progress taps
> have **never run on a real device/emulator**. On-device testing caught real crash
> bugs in D4/D5 that unit tests missed, so this walkthrough is owed before any real
> driver uses dispatch. **When you run it, record the outcome under "Last executed"
> and flip this to ACTIVE (or file what broke).**

## When this procedure applies

Run this before a real driver uses the dispatch flow — after `feat/driver-d6`
merges, or whenever the driver-app dispatch surface (`App.tsx` `RequestScreen` /
`OrderDetail`, `src/trip-map.tsx`, `src/routing.ts`, `src/arrival.ts`) changes.
It exercises the ride-hailing-style loop the operator will use to send trucks:
**request → accept → start → navigate → tap progress → (D6) see arrival status.**

## Why this is owed (the coverage gap this closes)

`src/trip-map.tsx` (the MapLibre island) and the map render are **device-only** —
jest maps the native module to a stub (`__mocks__/maplibre.tsx`), so the inline
map, the drawn route polyline, and the ETA label are never exercised in CI. The
pure helpers (`routing.ts`, `arrival.ts`, `trips.ts`) ARE unit-tested; the
**native + visual** surface is what only a device can verify.

## Prerequisites

1. The local stack up per `dev-setup.md` §"Procedure" (Postgres + Redis via
   `docker compose`, the API on `:3001`, migrations applied) and an **ADMIN** user
   seeded (`db:seed`, or `apps/api/scripts/seed-admin.ts`).
2. The driver app built + booted on the `fleetco-dev` Android emulator (or a
   device) per `dev-setup.md` §"Building the driver app (local prebuild)" — the
   one-time openjdk@17 + Android SDK toolchain, `expo prebuild`, `assembleDebug`,
   `adb install`, and the `EXPO_PUBLIC_API_URL=http://10.0.2.2:3001` wiring. **Do
   not duplicate that recipe here; follow it there.** For an offline pass, use the
   **bundled-debug** variant from that same section.
3. Location permission granted to the app so the D4/D5 GPS producer runs while the
   trip is IN_PROGRESS (Step 4 needs an ingested fix). Grant headlessly if needed:
   `adb shell pm grant com.fleetco.driver android.permission.POST_NOTIFICATIONS`.

## Step 1 — seed the dispatch scenario

Instead of hand-creating a driver, a vehicle, two Sites, and an OFFERED trip
through the admin web + Prisma Studio, run the seeder (idempotent; **local dev DB
only**):

```
CREATE_USER_PASSWORD='<temp driver password>' \
  pnpm --filter @fleetco/api exec tsx scripts/seed-dispatch-e2e.ts
```

It prints the created ids and the driver login (`driver-e2e@fleetco.local`). The
login is a real better-auth credential (it reuses `create-user.ts`), and the
`Driver.userId` link is set, so the own-record + D6 own-vehicle predicates
resolve. Re-running adds another fresh OFFERED request.

## Step 2 — build + boot the app

Per `dev-setup.md` §"Building the driver app (local prebuild)". Confirm the app
launches to the login screen with **no red-screen** (a fresh prebuild that drops
one of `@better-auth/expo`'s undeclared native peers — expo-network / constants /
linking / web-browser — red-screens before any screen renders; see that section).

## Step 3 — the dispatch click-path (the walkthrough)

Sign in as `driver-e2e@fleetco.local`. Then:

1. **Requests tab** → the OFFERED trip appears (reg `BA-1-KHA-0001`, material
   Aggregate, the pickup→drop-off route line on the card).
2. Tap the card → **order-detail**. Verify: Material = Aggregate; Pickup = *E2E
   Kalimati Crusher*; Drop-off = *E2E Pokhara Site*; the **inline MapLibre map**
   renders both pins; a **route polyline** connects them with an **"≈ … · … km
   (estimated)"** ETA label (from the live Mock `route-preview`); consignee *Ram
   Bahadur* with a tap-to-call row; expected load 3; special instructions; docket.
3. Tap **Accept** → the status flips OFFERED → ACCEPTED; the request leaves the
   Requests tab.
4. **Trips tab** → the accepted trip is now **startable**. Tap **Start**, enter the
   odometer reading → IN_PROGRESS.
5. Re-open the order (**"View order →"** on the Trips row). Now the **D6 "Arrival
   (from GPS)"** block and the **live progress checklist** show (both IN_PROGRESS-
   only).
6. Tap the four progress milestones **in order**: *Mark arrived at pickup → Mark
   loaded → Mark arrived at drop-off → Mark delivered.* Each stamps a timestamp and
   re-renders as a done row (a clock time, not a toggle). Only the next milestone is
   tappable.
7. **Navigate to pickup / drop-off** → opens the device maps app for turn-by-turn.
   (On the `google_apis` emulator image there is no Google Maps/Play app, so this
   falls back to a browser — expected; a real device / a `…_playstore` AVD opens
   Maps.)
8. Tap-to-call the consignee → the dialer opens with the number.
9. Back on the Trips tab, **Stop** the trip → COMPLETED.

## Step 4 — the D6 arrival-status check

While the trip is IN_PROGRESS, the "Arrival (from GPS)" rows read **Location
unknown** until the vehicle has an ingested GPS fix. Inject one at the pickup pin
(note `adb emu geo fix` takes **lon lat**, in that order):

```
adb emu geo fix 85.324 27.7172     # the E2E Kalimati Crusher pin
```

Once the D4/D5 producer captures + ingests it (a 202; the indicator polls every
30 s), the **Pickup** row flips to **Arrived** and **Drop-off** stays **Not yet**.
Move the fix far away (`adb emu geo fix 84.0 28.0`) → Pickup returns to **Not yet**.
This proves the own-vehicle derived read end-to-end from the phone. (Keep the
emulator screen ON — `adb emu geo fix` silently stops taking effect screen-off; see
`dev-setup.md` §"Building the driver app".)

## Step 5 — the monotonic-milestone probe (optional)

The UI only exposes the next milestone, so it cannot fire an out-of-order tap. To
confirm the **server** rejects one, PATCH an out-of-order milestone directly (e.g.
`loadedAt` before `arrivedPickupAt`) with the driver's cookie via `curl` — expect
**400** with a "must be greater than or equal to …" message. (The API suite already
pins this; the probe just confirms it over the real wire.)

## What is agent-assistable vs operator-led

- **Agent-assistable (CLI):** the whole build + AVD boot + `adb install` + the Step-1
  seed + `adb` permission grants / `geo fix` probes + the Step-5 `curl` probe, plus
  DB assertions (that Accept/Start/milestones landed on the row).
- **Operator-led (needs eyes on the emulator):** the visual confirmations in Step 3
  (the map actually renders, the ETA reads right, the pins are placed) and Step 7
  (Navigate opens maps). There is **no UI-automation harness** (no Detox/Maestro) in
  the repo, so the click-path itself is driven by hand.

## Gotchas (from the D4/D5 on-device experience — `dev-setup.md` has the full ledger)

- **Stale `dist`:** a long-lived `node dist/main.js` serves the last build, not the
  working tree. Before trusting a result, confirm the `:3001` listener is current
  (`ps -o lstart`) and `pnpm build` + restart if stale.
- **google_apis ≠ playstore:** Navigate falls back to a browser on the default AVD
  image (Step 7).
- **Screen-off geo-fix wedge:** keep the emulator screen on for Step 4.
- **`@better-auth/expo` native peers:** a red-screen at launch means a prebuild lost
  one — re-check `package.json` against `dev-setup.md`.

## Last executed

_Not yet executed on-device. Record the date, the emulator/device + API 35 build,
what passed, and anything that broke, then flip STATUS to ACTIVE._
