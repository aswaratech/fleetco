# ADR-0050: Staff agreements and the SUPERVISOR role — decision frame (open boxes)

- **Status:** Proposed — and **build-blocking**: unlike a ratified-by-merge program ADR, merging this PR records the *questions*, not answers. Construction starts only after the PO resolves every box below and ratifies the resolved version (the ADR-0044 Box A/B device: the boxes are the decision surface). An agent must never resolve a box, self-accept this ADR, or start SUPERVISOR/staff code while any box is open.
- **Date:** 2026-07-22
- **Decider:** Product owner (CEO) — pending

## Context

In the 2026-07-22 planning conversation that produced ADR-0049, the PO also asked for two things that ADR-0049 deliberately does not build:

1. **Agreement contracts with staff** — employment/engagement agreements with supervisors and other staff, stored like the customer/driver agreements ADR-0049 covers.
2. **A SUPERVISOR user level** — "another level of user (supervisor) that admin assigns the fleets and customers to look after."

These were split out because they change the **authorization model**, not just the data model. FleetCo's RBAC (ADR-0028) is a hardcoded, exhaustively-typed capability map over exactly three roles (ADMIN, OFFICE_STAFF, DRIVER); its one row-level scope (DRIVER, ADR-0034) is identity-linked (`Driver.userId`), not assignment-based. A SUPERVISOR role introduces FleetCo's first *assignment-based* scoping — which vehicles/customers a user may see or touch is decided by admin-managed assignment rows, not by who they are. And "staff" may or may not deserve a first-class aggregate. Each is a cross-cutting decision the PO must make explicitly — guessing them in code would be exactly the silent-architecture-invention CLAUDE.md forbids.

## Decision (skeleton — final only when every box resolves)

Add `SUPERVISOR` to `UserRole`; grant it a PO-chosen capability set (Box A); scope or organize its view of the fleet via admin-managed assignments (Box B); attach staff agreement documents per the Box C entity answer, as an additive extension of ADR-0049's FleetDocument (a fourth FK + matrix row).

### Box A — the SUPERVISOR capability row (PO to tick)

The `permissions.ts` map is exhaustive per role (`Record<UserRole, …>` — adding the enum member forces this row to exist at compile time). Proposed starting row, every token individually confirmable:

| Capability | Proposed | PO decision |
|---|---|---|
| `vehicles:*`, `drivers:*`, `trips:*`, `fuel-logs:*`, `expense-logs:*`, `jobs:*`, `customers:*`, `sites:*` | read + write on **assigned** scope only (Box B) | ☐ |
| `documents:read` / `documents:write` (ADR-0049) | yes, assigned scope | ☐ |
| `documents:delete` | **no** (stays ADMIN-only) | ☐ |
| `reports:read` | yes, assigned scope | ☐ |
| `gps:read-derived` (map/location of assigned vehicles) | yes | ☐ |
| `gps:read-raw`, `geofences:write`, `trackers:write`, `invoices:write`, `notifications:read`, `agent:use`, `users:manage` | **no** (ADMIN-sensitive set unchanged) | ☐ |

### Box B — assignment model and scoping semantics (PO to choose one)

- **B1 — Assignments SCOPE reads and writes** (the DriverScopeService pattern, generalized): a supervisor sees and touches ONLY assigned vehicles/customers and the records that hang off them (trips of assigned vehicles, jobs/invoices of assigned customers…). Strongest boundary; every list/detail/service gains a scope predicate — the largest build.
- **B2 — Assignments ORGANIZE, reads stay fleet-wide**: a supervisor reads everything (like OFFICE_STAFF) but writes only within assignments; assignments drive their dashboard/default filters. Cheaper, weaker boundary.
- Also to decide inside Box B: one generic assignment table vs two (`SupervisorVehicleAssignment` / `SupervisorCustomerAssignment`), and the relationship to the **deferred standing vehicle↔driver assignment** (`docs/tech-debt.md`) — one assignment framework or two.

### Box C — what is "staff"? (PO to choose one)

- **C1 — Supervisor-as-User**: staff agreements attach to the login (`FleetDocument.userId` FK). No new aggregate; staff without logins cannot hold documents.
- **C2 — A first-class Staff aggregate** (name, role/title, hire date, optional `userId` link — the Driver shape): staff exist independently of logins; agreements attach to Staff. Bigger, more honest for non-login staff (mechanics, helpers).

### Box D — fail-closed coercion target (confirm)

`toUserRole()` coerces any unexpected session role value to DRIVER (the smallest live capability set). SUPERVISOR must **never** become that target. Proposed: confirm DRIVER stays. ☐

## Alternatives considered

**Fold SUPERVISOR into ADR-0049.** Rejected — it would bury FleetCo's first assignment-based authz decision inside a document-storage program, forcing box answers by implication instead of PO choice.

**Model supervisors as OFFICE_STAFF + a UI filter.** No enforcement at all — a "scope" the API doesn't hold is decoration. Rejected as the answer, though Box B2 is its honest, enforced cousin.

**Skip the ADR and build on request.** The permissions map, a new scope service, and possibly a new aggregate are exactly the "would a future session need to know this?" material ADRs exist for. Rejected.

## Consequences

Recording the frame now means ADR-0049's document model stays supervisor-ready (the fourth FK is additive) and the PO's eventual decision is a form to fill, not a design session to schedule. The cost: the supervisor ask stays unbuilt until the boxes resolve — deliberate, per CLAUDE.md's "stop and ask".

## Revisit when

- The PO resolves the boxes → re-issue this ADR as resolved, ratify by merge, open the build program (its own tickets, its own phase-mismatch argument if the ADR-0041 window is still open).
- The standing vehicle↔driver assignment (tech-debt) starts first → Box B's assignment-framework question must be answered jointly, not twice.
