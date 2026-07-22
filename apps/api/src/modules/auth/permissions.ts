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
  // Reusable pickup/drop-off pin aggregate (ADR-0047 c4/c10). A COARSE
  // operation-class token like the Phase-1 aggregates — dispatch (and its Site
  // CRUD) is operational data entry both live roles do, so it joins the shared
  // operational floor below (ADMIN + OFFICE_STAFF). Deliberately NOT a
  // read/write split like geofences: a Site is operational master data (a
  // crusher's map pin), not users:manage-tier configuration the way a geofence
  // boundary is. A DRIVER never holds it — orders come only from the admin app.
  | "sites:*"
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
  // Notification/reminder-delivery audit history (ADR-0038 C4). READ-ONLY (the
  // NotificationLog is an append-only ledger; there is no :write). ADMIN-only:
  // "who we emailed about which lapse, and when" is operational AUDIT data at
  // the observability / users:manage tier, NOT operational data entry the office
  // staff touch — so it sits in the ADMIN set below, NOT the shared operational
  // floor (the same calculus as observability:read). A single read token, not a
  // read/write split, because the surface is read-only by construction.
  | "notifications:read"
  // Preventive-maintenance aggregate (ADR-0037: ServiceSchedule + ServiceRecord).
  // A coarse operation-class token like the Phase-1 aggregates: maintenance is
  // operational data entry the office staff do, so it joins the shared floor.
  // Minted by the 2026-07-02 RBAC hardening (the audit found both maintenance
  // controllers AuthGuard-only with no token to require).
  | "maintenance:*"
  // Invoice aggregate (ADR-0039). A READ/WRITE split like geofences, NOT a
  // coarse `invoices:*`, because the two operation classes carry genuinely
  // different privilege: reading/downloading an invoice is operational, but
  // WRITING one — and above all the irreversible issue / cancel / credit-note
  // lifecycle operations on a Nepal VAT tax document — is a financial act at
  // the users:manage tier. Both live roles read; only ADMIN writes. (Minted by
  // the 2026-07-02 RBAC hardening; ADR-0043 also excludes invoice writes from
  // the AI agent's tool registry entirely — the same "most dangerous surface"
  // judgment applied twice.)
  | "invoices:read"
  | "invoices:write"
  // Tracker-device register (ADR-0042 c6: the IMEI → vehicle mapping the
  // Traccar ingest adapter resolves on every forward). A READ/WRITE split
  // like geofences, NOT a coarse `trackers:*`, because the two operation
  // classes carry different privilege: both live roles READ the register
  // (which vehicle carries which unit — operational context for the live
  // map); only ADMIN WRITES it. Registering hardware and re-pointing a
  // vehicle's identity on the map is configuration at the users:manage tier
  // — a mis-assignment makes vehicle A render as vehicle B for as long as
  // it stands.
  | "trackers:read"
  | "trackers:write"
  // The AI chat agent (ADR-0043 c1). A single coarse token — "may this role
  // talk to the agent at all?" — because the agent's PER-TOOL authorization
  // is not this token's job: the tool registry re-checks each tool's own
  // capability against the requesting user's role before dispatch, so
  // holding agent:use never widens what a role could already do directly.
  // ADMIN-only in v1: the agent executes autonomous writes (from A7) with no
  // confirmation gate, so first use stays with the accountable owner;
  // OFFICE_STAFF is a deliberate later grant (an ADR-0043 "Revisit when"),
  // which is one row in the map below — not a controller edit.
  | "agent:use"
  // FleetDocument aggregate (ADR-0049 c6). READ and WRITE are operational
  // floor work — office staff already handle the same papers' Tier-2 metadata
  // via drivers:* — but DELETE is its own ADMIN-only verb token: deleting a
  // document's bytes irreversibly destroys compliance evidence (the
  // invoices:write calculus applied to papers; row deletes elsewhere are
  // Restrict-guarded, object deletes are not). Three tokens, not a coarse
  // documents:*, precisely so the destruction verb can carry different
  // privilege than day-to-day upload/edit. DRIVER holds none in v1.
  | "documents:read"
  | "documents:write"
  | "documents:delete"
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
  // Site CRUD (pickup/drop-off pins) is operational data entry the dispatcher
  // does — the same class as the Phase-1 aggregates above (ADR-0047 c4/c10).
  "sites:*",
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
  // Maintenance CRUD is operational data entry (schedules + completed-service
  // records), the same class as the Phase-1 aggregates above.
  "maintenance:*",
  // Reading/downloading invoices is operational; WRITING them (incl. the
  // irreversible issue/cancel/credit lifecycle) is ADMIN-only — see the
  // Capability union note on the invoices read/write split.
  "invoices:read",
  // Reading the tracker register joins the shared floor (ADR-0042 c6):
  // OFFICE_STAFF need to SEE which vehicle carries which unit — the same
  // calculus as geofences:read. WRITING the register (trackers:write) is
  // ADMIN-only and lives in the ADMIN set below.
  "trackers:read",
  // Fleet documents (ADR-0049 c6): uploading/reading the papers is operational
  // data entry — the same trust tier as the drivers:* PII the floor already
  // holds. DELETING documents (documents:delete) is ADMIN-only, below.
  "documents:read",
  "documents:write",
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
    // Writing the tracker register (register a device / assign it to a
    // vehicle / retire it) is ADMIN-only (ADR-0042 c6): the IMEI → vehicle
    // mapping decides which vehicle every hardware ping lands on, so a
    // write here re-points physical-world identity — the geofences:write
    // calculus applied to hardware.
    "trackers:write",
    // Reading the reminder-delivery audit history (ADR-0038 C4). ADMIN-only:
    // it is operational audit data (the NotificationLog ledger), above the
    // operational floor — an OFFICE_STAFF session does the data entry but does
    // not inspect what the compliance/maintenance reminder channel sent and when.
    "notifications:read",
    // Writing invoices — including the irreversible issue / cancel /
    // credit-note lifecycle on a VAT tax document — is a financial act above
    // the operational data-entry floor (the geofences:write calculus applied
    // to money). OFFICE_STAFF read invoices via the floor's invoices:read.
    "invoices:write",
    // Talking to the AI chat agent (ADR-0043 c1) — ADMIN-only in v1; see the
    // Capability union note for why this is a single coarse token.
    "agent:use",
    // Deleting fleet documents irreversibly destroys compliance-evidence
    // bytes (ADR-0049 c6) — the invoices:write calculus applied to papers.
    // The floor holds documents:read/write; only ADMIN removes.
    "documents:delete",
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
  //  (1) Since the 2026-07-02 RBAC hardening, these caps DO gate the trips /
  //      fuel-logs routes: every operational controller now carries
  //      `@RequirePermission` on the AuthGuard + RolesGuard chain, so a DRIVER
  //      session reaches ONLY the trips/fuel-logs routes (403 everywhere else
  //      — previously all 12 AuthGuard-only controllers, including drivers'
  //      Tier-2 PII and invoices, were open to any signed-in role). On the two
  //      routes it CAN reach, the SERVICE-LAYER own-record predicate
  //      (DriverScopeService.resolveOwnDriverId, ADR-0034 c7) remains the
  //      row-level constraint: a DRIVER may read / act on only their OWN trips
  //      and fuel logs (via the Driver.userId link, ADR-0034 c4), and may not
  //      create or delete either. Route gate = which operation classes; row
  //      scope = which records. Both are required.
  //
  //  (2) `gps:ingest` — GRANTED as of D4 (ADR-0035; the 2026-07-10 resumption),
  //      honoring ADR-0034 c5's hard rule by landing ATOMICALLY with its
  //      row-level predicate: `TelematicsService.assertDriverCanIngest` scopes
  //      a DRIVER batch to the driver's OWN IN_PROGRESS trip — every ping must
  //      carry `tripId`, each trip must resolve to the actor's own Driver row
  //      (DriverScopeService) with status IN_PROGRESS, and each ping's
  //      `vehicleId` must equal that trip's vehicle; ANY violation rejects the
  //      WHOLE batch 403, fail-closed, before anything is enqueued.
  //      `gps:read-derived` — the last cap of ADR-0034 c6's lean set — is
  //      GRANTED as of D6, honoring the same ADR-0034 c5 grant-with-scope rule:
  //      `TelematicsService.assertDriverCanReadVehicle` scopes a DRIVER to
  //      their OWN vehicle's derived status (the vehicle on their IN_PROGRESS
  //      trip), while the fleet-wide `/positions/latest` stays 403 for a DRIVER
  //      (`assertCanReadFleetPositions`) — so the cap reads a driver's own
  //      geofence context (D6 arrival status), never the fleet's live map.
  [UserRole.DRIVER]: new Set<Capability>([
    "trips:*",
    "fuel-logs:*",
    "gps:ingest",
    "gps:read-derived",
  ]),
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
// fail-closed coercion for the whole auth surface: the RolesGuard
// (authorization), `GET /me` (UI-gating signal), and the trips/fuel-logs
// Actor threading all read the session role through here, so they can never
// disagree on how an unexpected value is treated. On any value that is not
// exactly ADMIN or OFFICE_STAFF it returns DRIVER — the LEAST-privileged live
// role: DRIVER holds only trips:*/fuel-logs:* and is further constrained by
// the DriverScopeService own-record predicate, which fails closed (403) for a
// user with no Driver link. (The pre-D2 version of this coercion targeted
// OFFICE_STAFF, which was least-privileged THEN; once DRIVER became a live
// role with the smallest set — and especially once the 2026-07-02 hardening
// put @RequirePermission on every operational controller — an
// unexpected-value coercion to OFFICE_STAFF would have ESCALATED a corrupted
// session onto the whole operational floor. Fail-closed must track the
// smallest live set.) At runtime the column is NOT NULL with a valid enum
// default, so this branch is unreachable in practice; it exists to satisfy
// the type system and to fail closed if that invariant is ever broken.
export function toUserRole(role: string | null | undefined): UserRole {
  return role === UserRole.ADMIN || role === UserRole.OFFICE_STAFF ? role : UserRole.DRIVER;
}
