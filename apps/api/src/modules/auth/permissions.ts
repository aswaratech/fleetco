import { UserRole } from "@prisma/client";

// The RBAC permission model (ADR-0028 commitment 4): a single, HARDCODED,
// in-tree role -> capability map. This file is the one place that answers "what
// may each role do?" and is the security primitive the RolesGuard enforces.
//
// Why hardcoded TypeScript and not a DB-driven policy table (ADR-0028 c4):
// the permission model IS project memory, and per ADR-0009 memory belongs in
// version-controlled files that diff cleanly and are code-reviewed — not in a
// mutable DB row a future agent can't see in a diff and a fat-fingered admin
// (or an attacker) could rewrite at runtime. For two live roles and a small
// capability set, a runtime-editable policy editor is pure overhead and a new
// mutable security surface; it earns its place only at a role/permission count
// a single-company internal tool is nowhere near (recorded as an ADR-0028
// "Revisit when", not adopted).

// A capability is a COARSE, operation-class token (ADR-0028 c4/c9) — "may this
// role perform this class of operation?", never "may this user see THIS record"
// (row-level scoping is ADR-0028 c9's deferred concern, landing with DRIVER).
// The `*` in the operational tokens (e.g. `vehicles:*`) is part of the token
// NAME — it denotes the whole vehicles operation-class as a single coarse
// capability — NOT a glob expanded at match time. Enforcement is therefore
// exact set-membership (see `roleHasCapability`). The union is closed: a
// controller can only `@RequirePermission(...)` a token that exists here, so a
// typo is a compile error, not a silently-open route.
export type Capability =
  | "vehicles:*"
  | "drivers:*"
  | "customers:*"
  | "jobs:*"
  | "trips:*"
  | "fuel-logs:*"
  | "expense-logs:*"
  | "reports:read"
  // Geofence configuration aggregate (ADR-0030 c5). A verb-token READ/WRITE
  // split (like the gps:read-derived / gps:read-raw tokens, NOT a coarse
  // `geofences:*`) precisely so the two operations carry DIFFERENT privilege:
  // both live roles READ fences for the derived operational views (live map /
  // geofence status), but only ADMIN may WRITE (redraw a boundary) — geofence
  // boundaries are operational *configuration* at the users:manage tier.
  | "geofences:read"
  | "geofences:write"
  | "gps:ingest"
  | "gps:read-derived"
  | "gps:read-raw"
  | "gps:export-raw"
  | "observability:read"
  | "users:manage"
  | "roles:assign";

// The operational capability floor shared by BOTH live roles. ADMIN and
// OFFICE_STAFF alike do the Phase-1 operational CRUD plus reports and the
// DERIVED GPS views (live-location map, geofence status, trip route summary);
// ADMIN then layers the sensitive tokens on top. Declaring the shared floor
// once keeps the two role sets from drifting (the office-staff set is exactly
// "operational", and the admin set is "operational + sensitive").
const OPERATIONAL_CAPABILITIES: readonly Capability[] = [
  "vehicles:*",
  "drivers:*",
  "customers:*",
  "jobs:*",
  "trips:*",
  "fuel-logs:*",
  "expense-logs:*",
  "reports:read",
  "gps:read-derived",
  // Reading geofence configuration joins the shared floor (ADR-0030 c5):
  // OFFICE_STAFF need to SEE the depot / customer-site / route-corridor fences
  // the derived live-location and geofence-status views read against — exactly
  // parallel to gps:read-derived already on this floor. WRITING fences
  // (geofences:write) is ADMIN-only and lives in the ADMIN set below.
  "geofences:read",
];

// The role -> capability map, exactly per ADR-0028 c4's table. Keyed by the
// Prisma `UserRole` enum so the `Record` is EXHAUSTIVE: if a fourth role is
// ever added to the enum, this object fails to compile until it is given a
// capability set — the role count can never silently outrun the policy.
export const ROLE_CAPABILITY_MAP: Record<UserRole, ReadonlySet<Capability>> = {
  // ADMIN — the CEO/owner, the single most-privileged human: everything
  // OFFICE_STAFF can do PLUS every privileged/sensitive operation. The
  // load-bearing splits (ADR-0028 c6, discharging ADR-0027 c7 / ADR-0026 c7):
  // raw-GPS trace query/export and the observability surface are ADMIN-only,
  // strictly above the derived GPS views; so are user/role administration.
  // GPS *ingestion* (`gps:ingest`, ADR-0029 c11) is also ADMIN-only TODAY —
  // a placeholder so the telematics ingestion endpoint can be built and
  // tested before the driver app exists; it is GRANTED TO `DRIVER` when that
  // role is defined with the driver-app slice, which is purely a new row in
  // this map (the point of the capability indirection), NOT a controller edit.
  [UserRole.ADMIN]: new Set<Capability>([
    ...OPERATIONAL_CAPABILITIES,
    "gps:ingest",
    "gps:read-raw",
    "gps:export-raw",
    "observability:read",
    // Writing geofence configuration (create / update / delete a boundary) is
    // ADMIN-only (ADR-0030 c5): redrawing the depot or a customer-site fence is
    // operational *configuration* at the same privilege tier as users:manage —
    // an OFFICE_STAFF session reads fences (the floor's geofences:read) but does
    // not redraw them.
    "geofences:write",
    "users:manage",
    "roles:assign",
  ]),
  // OFFICE_STAFF — a trusted employee doing operational data entry: the
  // operational floor and DERIVED GPS views only. NOT raw-GPS export, NOT
  // GPS ingestion (`gps:ingest` is ADMIN-only today, DRIVER-held later —
  // ADR-0029 c11), NOT observability, NOT user/role admin (ADR-0028 c1/c4).
  // The threat model is "limit the blast radius of a compromised office-staff
  // session", not "office staff is hostile".
  [UserRole.OFFICE_STAFF]: new Set<Capability>(OPERATIONAL_CAPABILITIES),
  // DRIVER — DEFINED as of ADR-0034 (the driver-app auth slice), transitioning
  // from ADR-0028 c1's reserved-but-empty placeholder. D2 grants exactly the two
  // write capabilities a driver exercises from the phone: `trips:*` (start / stop
  // their own trips) and `fuel-logs:*` (log fuel / odometer against their own
  // trip). Two things are load-bearing to understand:
  //
  //  (1) These caps do NOT, by themselves, gate the trips / fuel-logs routes.
  //      Those Phase-1 controllers are auth-guarded but NOT RolesGuard-gated (no
  //      `@RequirePermission`), so `roleHasCapability` is never consulted for
  //      them. Per ADR-0034 c7 the SOLE new enforcement is a SERVICE-LAYER
  //      own-record predicate (DriverScopeService.resolveOwnDriverId): a DRIVER
  //      may read / act on only their OWN trips and fuel logs (resolved through
  //      the Driver.userId link, ADR-0034 c4), and may not create or delete
  //      either. The set here is the map's RECORD of the grant (and future-proofs
  //      any route that later opts into `@RequirePermission`); the row-scope is
  //      what actually constrains a driver.
  //
  //  (2) `gps:ingest` and `gps:read-derived` — the other two caps ADR-0034 c6
  //      assigns DRIVER — are DEFERRED, not forgotten. ADR-0034 c5's hard rule is
  //      that no DRIVER WRITE capability enters this map without its row-level
  //      predicate IN THE SAME CHANGE. `gps:ingest` is write-equivalent and its
  //      own-vehicle scope is the offline-producer work (D4/D5, ADR-0035);
  //      `gps:read-derived` would, unscoped, expose every vehicle's derived
  //      status, and its own-vehicle scope is the geofence-context work (D6).
  //      Each is granted when its scope lands — the lean set (c6) is reached
  //      incrementally, never as an unscoped write.
  [UserRole.DRIVER]: new Set<Capability>(["trips:*", "fuel-logs:*"]),
};

// Does `role` hold `capability`? Exact set-membership against the coarse map
// above (the `*` tokens are names, not globs — see the `Capability` note).
export function roleHasCapability(role: UserRole, capability: Capability): boolean {
  return ROLE_CAPABILITY_MAP[role].has(capability);
}

// Narrow better-auth's loose session `role` (typed `string | null | undefined`
// because the library has no native enum field type — the value is declared as
// a plain string additionalField in auth.ts, with the real enum enforced at the
// Prisma/Postgres layer) to the domain `UserRole`. This is the SINGLE
// fail-closed coercion for the whole auth surface: both the RolesGuard
// (authorization) and `GET /me` (UI-gating signal) read the session role
// through here, so they can never disagree on how an unexpected value is
// treated. On any value that is not exactly ADMIN or DRIVER it returns
// OFFICE_STAFF — the least-privileged LIVE role — so a corrupted or empty
// session can never be silently treated as more privileged than office staff.
// (At runtime the column is NOT NULL with a valid enum default, so the
// unexpected-value branch is unreachable in practice; the coercion exists to
// satisfy the type system and to fail closed if that invariant is ever broken.)
export function toUserRole(role: string | null | undefined): UserRole {
  return role === UserRole.ADMIN || role === UserRole.DRIVER ? role : UserRole.OFFICE_STAFF;
}
