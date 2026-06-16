# ADR-0034: Mobile auth and the DRIVER role — better-auth bearer tokens for the native client, a User↔Driver identity link, and a row-scoped DRIVER capability set that never ships a write without its own-record predicate

- **Status:** Accepted
- **Date:** 2026-06-06
- **Decider:** Product owner (CEO)
- **Accepted:** 2026-06-09

## Acceptance

Accepted by the product owner (CEO) on 2026-06-09, ratifying: better-auth `bearer()` for the native client; the new `User`↔`Driver` link migration (none exists today); the lean, row-scoped DRIVER capability set; and — the load-bearing condition — that **no DRIVER write capability ships without its own-record predicate in the same change** (DRIVER enforcement does not reach production without the own-scope filter). Accepted after ADR-0033 and before ADR-0035, per the load-bearing acceptance order. The implementing slices (D1 auth, D2 trip-scope) may proceed; the glossary's DRIVER reserved→defined transition lands with them.

## Context

Phase 2 is open per ADR-0025. This is the **second of three driver-app foundation ADRs** (ADR-0033 platform accepted first; ADR-0035 offline producer after). The driver app (ADR-0033) needs its users — drivers — to (a) authenticate against the existing NestJS API from a native client and (b) be authorized as the `DRIVER` role that ADR-0028 named but deliberately left undefined.

The repo's memory has pointed at this exact moment for a long time, so it can be decided cleanly rather than invented:

- **ADR-0028 commitment 1** reserved `DRIVER` and said a driver's permission shape "is almost entirely *row-level* ('their own trips, their own traces'), which depends on the driver-app design … and on the row-level-scoping work this ADR defers (commitment 9)." Its **"Revisit when" #1** names the trigger now firing: "The `DRIVER` role / driver app arrives. Define DRIVER's permissions and, with it, the deferred row-level/field-level scoping (commitment 9) … Coordinate with ADR-0027's data-subject-request path." **This ADR realizes that.**
- **ADR-0029 commitment 11** built `gps:ingest` as ADMIN-held "so tests can exercise it, and later granted to the `DRIVER` role … a new map row, not a controller edit." Its "Revisit when" likewise hands the offline mechanics to "the driver-app slice."
- **ADR-0028 commitment 9** chose the capability-token indirection "partly so row-level predicates can later attach to capabilities without re-architecting the guard." This ADR is that attachment.

The current substrate was verified against the source:

- **better-auth `~1.6.11`.** `apps/api/src/modules/auth/auth.ts` enables `emailAndPassword` + a `role` `additionalField` (`input: false`, default `OFFICE_STAFF`) + `trustedOrigins` built from `env.CORS_ORIGIN`. **No `bearer` or Expo plugin is enabled.** `AuthGuard` (`auth.guard.ts`) resolves the session via `getSession({ headers: fromNodeHeaders(request.headers) })` — which **reads an `Authorization` header**, so bearer composes with **zero guard change** and the web's cookie path is unaffected.
- **`permissions.ts`:** `DRIVER` is `new Set<Capability>()` (empty); `roleHasCapability` is **exact set-membership with no row check**; the file's own comment states a driver's permissions "are almost entirely row-level." `create-user.ts`'s `parseRoleArg` **rejects `DRIVER`** today.
- **The identity gap (the load-bearing finding).** There is **no link in the schema between a `User` (the login identity) and a `Driver` aggregate row or a vehicle.** `Driver` references `User` only through `createdById` (the admin who created the record); `Trip` carries `driverId` (→`Driver`) and `vehicleId` (→`Vehicle`) independently. So a logged-in `DRIVER` — a `User` row with `role = DRIVER` — has **no notion of "their own" trip or vehicle**. Row-level scoping is therefore not merely a guard predicate; it needs an identity link that does not exist.

A native mobile client cannot cleanly use the web's `httpOnly` cookie sessions, and a long-lived credential on an operator-installed phone is a **new authentication mechanism and a new credential class** — a cross-cutting auth-surface change that, per CLAUDE.md step 4, is PO-confirmed before code. This ADR is that vehicle. It **decides shape and policy only**; it writes no code. The edits it specifies (a `bearer()` plugin in `auth.ts`, a `DRIVER` row in `permissions.ts`, a `parseRoleArg` branch in `create-user.ts`, and a `Driver.userId` migration) are **additive** and land with the implementing slices (D1 auth; D2 trip-scope).

## Decision

**Authenticate the native driver client with better-auth's `bearer()` plugin (enabled server-side, additive; the client uses `@better-auth/expo` + `expo-secure-store` and sends `Authorization: Bearer <token>`, which the existing `AuthGuard` already reads); introduce a `User`↔`Driver` identity link (a nullable-unique `Driver.userId`) so "their own" has a definition; and define the `DRIVER` capability set as a lean, least-privilege footprint enforced by a service-layer own-record predicate, under one non-negotiable rule — no DRIVER *write* capability enters the permission map without its row-level predicate landing in the same change.** Nine commitments define the shape, grouped. As with its siblings, this ADR **writes no code**; the implementing slices build it.

### A. Mobile authentication (bearer)

1. **Enable better-auth `bearer()` server-side; the client is `@better-auth/expo` + `expo-secure-store`.** `bearer()` is added to the `betterAuth({ plugins: [...] })` array — an **additive** change: the existing cookie/session path the web admin uses is untouched (the implementing slice includes a **regression test that web-admin cookie login still passes** after the plugin lands). The native client obtains a token on sign-in, stores it in **`expo-secure-store`** (never `AsyncStorage`, never logged), and sends `Authorization: Bearer <token>` on every API call. No guard change is needed: `AuthGuard` already resolves the session from request headers (verified).
2. **The `fleetco://` scheme is the Expo *client* plugin's scheme, not a `trustedOrigins` entry.** `trustedOrigins` is built from the web `CORS_ORIGIN` and is a CSRF / cookie / redirect-origin control — it is **not consulted for bearer-token authentication** (a bearer request authenticates purely from the `Authorization` header). The `fleetco://` deep-link scheme therefore belongs on the `@better-auth/expo` *client* configuration, not in server `trustedOrigins`. Touch `trustedOrigins` only if a cookie/OAuth surface is later added for mobile, and **never** add a wildcard origin. The implementing slice verifies against the final pure-bearer client config whether any `trustedOrigins` edit is needed at all.
3. **Token lifetime, mid-trip re-auth, and revocation-on-role-change are pinned in the implementing slice.** A stored **bearer token is a long-lived credential** and does *not* refresh the way a cookie session does, which makes two obligations load-bearing: (a) a token **TTL** plus a **mid-trip re-auth UX** — a driver whose token expires mid-route must be prompted to re-authenticate, not silently 401-dropped with a stalled offline outbox (ADR-0035); and (b) **revocation-on-role-change**, which ADR-0028 commitment 3 already flagged as unsettled (it relied on better-auth's revocable sessions). Because a bearer token is harder to revoke than a cookie session, the slice must define how a role downgrade or account disable invalidates a *live* driver token — e.g. a short TTL combined with a server-side session/token revocation check. The better-auth bearer plugin's own security caution (a bearer token is a standing credential to be handled carefully) is recorded in Consequences.

### B. The User↔Driver identity link

4. **Add a `User`↔`Driver` link so "their own" has a definition.** A migration adds **`Driver.userId String? @unique`** (+ a relation to `User`): **nullable** because existing/office-created `Driver` rows may have no login yet, and **unique** because one login maps to at most one driver. This link is what makes scoping possible: a driver's **own trips** are `Trip` rows whose `driverId` resolves (through the link) to the authenticated user's `Driver`; their **own vehicle** is the vehicle on their active trip. The own-record predicate lives at the **service layer** on the reused endpoints — *not* a new guard concept and *not* a Prisma global middleware — composing ADR-0028 commitment 9's capability indirection with a service-layer filter. This is the smallest mechanism that scopes a driver to their own data without re-architecting the guard.

### C. The DRIVER capability set and the non-negotiable sequencing rule

5. **The hard rule: no DRIVER *write* capability enters the map without its row-level predicate in the same change.** `trips:*`, `fuel-logs:*`, and `gps:ingest` are *write* (or write-equivalent) capabilities, and the capability map is **coarse operation-class membership with no row check** (verified). Granting any of them to `DRIVER` *without* the own-record predicate would hand a driver session write authority over the **entire fleet's** trips and fuel logs — the empty-Set safety property ADR-0028 deliberately gave `DRIVER` would degrade to nothing. Therefore: **D1 (auth) grants `DRIVER` no fleet-wide write capability**; the write capabilities and their own-vehicle/own-trip scope land **atomically in D2**. This is a **hard acceptance condition** of this ADR: *DRIVER enforcement does not reach production without the own-scope filter in the same change as the grant.* (This corrects the tempting D1-then-D2 split — the grant and its scope are inseparable.)
6. **The DRIVER capability set is lean and least-privilege.** When scoped (commitment 5), `DRIVER` holds exactly: **`gps:ingest`** (stream pings — moved off ADMIN per ADR-0029 c11), **`trips:*`** (own trips), **`fuel-logs:*`** (own fuel/odometer entries), and **`gps:read-derived`** (their own vehicle's live/geofence status). It **withholds** `gps:read-raw`/`gps:export-raw` (raw trace is the most-privileged class, ADMIN-only — ADR-0027 c7), `observability:read`, `geofences:write`, `reports:read`, `users:manage`, `roles:assign`, and the other operational aggregates (`vehicles:*`, `drivers:*`, `customers:*`, `jobs:*`, `expense-logs:*`). **Do not grant blanket `geofences:read`** — it would expose **every** depot and customer-site boundary (Tier-3 customer configuration, ADR-0027 c6) to the least-trusted role; a driver needs geofence *status* for their active trip (already covered by the scoped `gps:read-derived`), not the geofence *configuration* list. If D6 needs more, it is added scoped, with a concrete need.
7. **Reuse the existing endpoints; add no mobile BFF.** Trip start/stop reuses **`PATCH /trips/:id`** (the existing status-transition rules: →IN_PROGRESS captures `startedAt`+`startOdometerKm`, →COMPLETED requires `endedAt`+`endOdometerKm` and bumps the vehicle odometer); odometer + fuel reuse **`POST /fuel-logs`**; pings reuse **`POST /api/v1/telematics/pings`** (ADR-0029 c10). The capability indirection means the **controllers are untouched** — exactly what `permissions.ts`'s `gps:ingest` comment anticipates ("a new map row … NOT a controller edit"). The **only** new enforcement is the service-layer own-record predicate (commitment 4). A `/driver/*` mobile-BFF write path is rejected (Alternatives): it would duplicate validated cross-field rules for no gain.
8. **Provisioning: `create-user.ts` accepts `DRIVER`, additively; drivers are admin-created and linked.** `parseRoleArg` gains a `DRIVER` branch (same privileged direct-write path that creates office-staff/admin accounts; **`input: false` is preserved** — role is never public input, the privilege-escalation defense). Drivers are **admin-created** (no self-serve), consistent with `input: false`, and the created `User` is **linked to a `Driver` row** (commitment 4). The exact UX of linking an existing `Driver` to a new login is the slice's to pin.

### D. SLI

9. **The "driver-app trip-start success" SLI.** **ADR-0026 commitment 6** already named this indicator and set its **provisional 99.0% target** (matching ADR-0011's existing core-operation SLO, since a failed trip-start blocks a driver from working). This ADR does **not** re-set the target — it **instruments the ADR-0026 target in D2** via the existing `apps/api/src/common/sli.ts` pattern, trip start being the driver app's first business-critical write. It also settles the one open definitional question ADR-0026 c6 reserved for "when the driver app's … behaviour is designed": the SLI counts **server-side failures of trip-start requests that reach the API**, not app-side connectivity failures (an unreachable API is the cellular network's problem — the same reasoning ADR-0026 c6 applied to ping-freshness), so the number is not punished for coverage gaps.

### Relationship to prior ADRs (what this realizes, consumes, and tensions)

- **Realizes ADR-0028 commitment 1 + "Revisit when" #1** (defines `DRIVER` and, with it, the deferred row-level scoping of commitment 9) and **ADR-0029's "Revisit when"** (`gps:ingest` moves from ADMIN to `DRIVER` — a map row, not a controller edit).
- **Consumes ADR-0027 commitment 7** (raw vs derived — `DRIVER` gets derived-only) and **commitment 6** (geofence config is Tier-3 customer data — not blanket-granted), and coordinates with ADR-0013/ADR-0027's data-subject path for a driver's own data.
- **Builds on ADR-0015** (better-auth; `bearer()` is an additive plugin, no library swap) and **ADR-0021** (the integration shape is untouched — the guard already reads `Authorization`). **Tension with ADR-0015/ADR-0028 c3:** ADR-0015 valued better-auth's revocable sessions over JWTs precisely for revocation; a bearer token is closer to a JWT in that respect, so commitment 3 must restore revocability deliberately.
- **Is consumed by ADR-0035**, whose offline producer authenticates via this bearer token and ingests under this `gps:ingest` grant.
- **Is the PO-confirmation vehicle** for the new auth mechanism + credential class per CLAUDE.md step 4 — no auth/role code is written until this ADR is accepted.
- **On acceptance**, the glossary **redefines DRIVER** — *documenting the transition* (reserved per ADR-0028 → defined per ADR-0034), not overwriting — and gains **bearer token** / **secure storage** entries; those updates land with the implementing slice.

## Alternatives considered

**Cookie sessions on the mobile client.** Rejected (commitment 1): React Native does not manage `httpOnly` cookies natively, and the background ping flusher (ADR-0035) runs with no React context, so a cookie path would force manual cookie injection on every request from a headless task. A flat bearer token forwards cleanly into a background task.

**A bespoke JWT scheme.** Rejected (commitment 1): better-auth ships `bearer()` + `@better-auth/expo` first-party, so rolling our own would reimplement `getSession` and token issuance — the kind of new pattern CLAUDE.md forbids when a library primitive exists.

**A `fleetco://*` wildcard trusted origin.** Rejected (commitment 2): a wildcard custom-scheme origin is broader than the exact-match origins `trustedOrigins` carries today, and for a pure-bearer client `trustedOrigins` is not even consulted — the scheme belongs on the client plugin.

**Grant `DRIVER` flat `trips:*`/`fuel-logs:*` now and add row-scope in a later PR.** Rejected (commitment 5): it ships fleet-wide write authority to the least-trusted role and lets a production-capable PR sit with that gap open until the scope PR lands. The grant and its predicate are inseparable.

**A `/driver/*` mobile-BFF namespace with mobile-tailored write endpoints.** Rejected (commitment 7): it duplicates the validated cross-field rules (status transitions, trip-vehicle consistency, derived `totalCostPaisa`) the existing endpoints already enforce — a second write path is a forbidden new pattern for no gain at this scale.

**Grant `DRIVER` blanket `geofences:read`.** Rejected (commitment 6): it exposes every customer-site boundary (Tier-3 customer data) to the least-trusted role. The scoped derived read already gives a driver the geofence *status* they need.

**Build the auth/role code now without an ADR.** Rejected on CLAUDE.md step 4: a native auth mechanism plus a new credential class plus the third human role is a cross-cutting security-surface change that warrants explicit PO confirmation before code — exactly what ADR-0028 said the `DRIVER` definition would need.

## Consequences

### What this makes easier

Drivers authenticate against the existing API with **zero guard rewrite** (the guard already reads `Authorization`), and the web's cookie path is untouched. The `User`↔`Driver` link gives "their own" a precise definition, and the service-layer predicate scopes a driver to their own data without re-architecting the guard. Reusing the existing endpoints means no duplicated write logic and no second validation surface. The lean capability set gives `DRIVER` a safe, least-privilege footprint that is a one-row change to widen if a real workflow needs it.

### What this makes harder

A **third human credential class** now exists — a long-lived token on a phone that can be lost, phished, or extracted — and **bearer revocation is harder than cookie-session revocation** (commitment 3 is the cost of restoring it). The `User`↔`Driver` link is a new invariant (every driver login must map to a `Driver`). The own-record predicate is a **new enforcement layer** on the reused services that every future driver-reachable endpoint must apply — a forgotten predicate on a new driver endpoint is a fleet-wide-exposure bug, the same standing "check every new surface against the policy" cost ADR-0028's splits already carry. Role-change propagation to a live token is a real behavior to get right.

### Costs we accept

- **The row-scope predicate is real work that gates DRIVER's production use** (the hard acceptance condition, commitment 5). We accept that `DRIVER` is inert in production until D2's scope lands — the safe direction to fail.
- **A stored bearer token is a standing credential** until its TTL/revocation expires it. We accept this in exchange for a clean native auth path, mitigated by a short TTL + a revocation check (commitment 3).
- **The lean capability set may prove too tight** for a real driver workflow. We accept this as the least-privilege default; widening is a one-row, code-reviewed change, scoped.

## Revisit when

- **A real driver workflow needs a capability not in the lean set** (commitment 6). Add it *scoped*, governed here.
- **The own-record predicate pattern recurs** — a multi-office partition, or ADR-0028 commitment 9's other consumers. Revisit whether scoping graduates from per-service filters to a guard-level or Prisma-middleware mechanism.
- **The driver-app security review** (ADR-0028's "Revisit when" names introducing a third human role + mobile sessions as the checkpoint). The new credential class is the trigger for a focused review of the multi-role auth surface.
- **better-auth's `bearer`/Expo surface changes** at a version bump (ADR-0015's swap contract): re-confirm token handling against the new surface.
- **A driver token is stolen, or a phone is lost in the field.** Revisit TTL, revocation, and whether device-binding/attestation is warranted.
- **Acceptance fixes the picks** (bearer, the link, the lean scoped set, and the hard sequencing rule); if the PO chooses differently, the slice follows and this ADR is annotated.
