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
  [UserRole.ADMIN]: new Set<Capability>([
    ...OPERATIONAL_CAPABILITIES,
    "gps:read-raw",
    "gps:export-raw",
    "observability:read",
    "users:manage",
    "roles:assign",
  ]),
  // OFFICE_STAFF — a trusted employee doing operational data entry: the
  // operational floor and DERIVED GPS views only. NOT raw-GPS export, NOT
  // observability, NOT user/role admin (ADR-0028 c1/c4). The threat model is
  // "limit the blast radius of a compromised office-staff session", not
  // "office staff is hostile".
  [UserRole.OFFICE_STAFF]: new Set<Capability>(OPERATIONAL_CAPABILITIES),
  // DRIVER — reserved but UNDEFINED (ADR-0028 c1): no capabilities. The enum
  // names it so this map (and the guard) accept a third role without rework,
  // but a driver's permissions are almost entirely row-level and depend on the
  // deferred scoping work + the driver-app design, so they land with that
  // slice, not here. An empty set means a DRIVER session is inert against every
  // gated route today — the safe default for a not-yet-built role.
  [UserRole.DRIVER]: new Set<Capability>(),
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
