# Glossary

This is the project's semantic memory: the place where words have agreed meanings. Add new terms here on first use. The glossary is alphabetical within sections. Entries are not silently removed; if a term changes meaning over time, the change is documented in the entry rather than its history erased.

## Fleet and operations vocabulary

**Bishesh Anumati (विशेष अनुमति)** is the Nepali term for a special permit, often required to operate certain heavy vehicles or to operate on certain routes. It is one of the compliance documents tracked by the system, and its expiry triggers a reminder.

**Bluebook (नीलो किताब)** is the vehicle registration certificate issued by Nepal's Department of Transport Management. It is called the Bluebook because of the color of its cover. Every vehicle in FleetCo has a Bluebook number and metadata, and Bluebook expiry triggers compliance reminders. As of Phase 1 iter 14, persisted on Vehicle as `bluebookNumber` (string, nullable) and `bluebookExpiresAt` (DateTime, nullable).

**Customer** is a party who hires FleetCo's vehicles for jobs. A customer is distinct from a lease-taker. A customer engages FleetCo to do work; a lease-taker rents vehicles to do their own work. As of Phase 1 iter 15, Customer is persisted as its own aggregate with `name` (Tier 3 business identifier), `contactPerson` (Tier 2 PII, nullable), `phone` (Tier 2 PII), `email` (Tier 2 PII, nullable), `panNumber` (Permanent Account Number; Tier 3 tax-identifier, unique-when-present), `address` (Tier 3, nullable), and `status` (`customer.status` enum), all under `model Customer` in `apps/api/prisma/schema.prisma`. Iter 15 shipped the read path (schema + migration, `GET /api/v1/customers`, `GET /api/v1/customers/:id`, list and detail UI, home-page nav link). Iter 16 shipped the write path (`POST` / `PATCH` / `DELETE /api/v1/customers/:id`, plus create / edit / delete UI under `apps/web/src/app/customers/`), with PAN normalization (trim + uppercase) at the service layer, the PAN-uniqueness `P2002` → 409 mapping mirroring the iter-7 license-number rule on Drivers (response body carries `field: "panNumber"` so the web form surfaces the conflict inline on the PAN input), and forward-compatible `P2003` → 409 ("Cannot delete customer: it is referenced by other records.") on `DELETE` ahead of the first inbound FK. Customer has no inbound FKs from other aggregates yet — the iter-17 Jobs slice will be the first cross-slice consumer and the first to exercise the delete-conflict branch.

**customer.status** is the enum tracking whether a customer is current business or dormant business. Values are `ACTIVE` (default; current paying business) and `INACTIVE` (a customer the operator has stopped working with, kept on file for historical / accounting reference). The Customer status set is deliberately smaller than the Driver / Vehicle status sets: a customer relationship does not have intermediate "on leave" / "in maintenance" semantics — either they are a customer right now or they are a former customer. Phase 1 iter 15 shipped the read filter; iter 16 shipped the write path which preserves the same two-value set (the create form defaults `status` to `ACTIVE`; the edit form lets the operator toggle between `ACTIVE` and `INACTIVE`).

**Driver** is an employed or contracted person who operates vehicles on trips. Drivers have license metadata (`licenseNumber`, `licenseClass`, `licenseExpiresAt`), Tier 2 PII (`fullName`, `phone`, optional `dateOfBirth`), and an employment status (`driver.status`). Drivers are participants in trips; they are not the central aggregate. Iter 6 shipped the read path (schema, list and detail API, list and detail UI). Iter 7 shipped the write path (`POST` / `PATCH` / `DELETE /api/v1/drivers`, plus create / edit / delete UI under `apps/web/src/app/drivers/`). As of iter 13, the Driver detail page surfaces lifetime stats (completed trip count, total km logged across COMPLETED trips, and the vehicle paired with the most recent trip) via `GET /api/v1/drivers/:id/stats` — the symmetric mirror of the iter-12 lifetime-stats surface on the Vehicle detail page.

**driver.status** is the enum tracking a driver's employment state. Values are `ACTIVE` (default; eligible to be assigned to trips), `ON_LEAVE` (temporarily unavailable but still employed), `SUSPENDED` (administratively withheld from trips pending a decision), and `TERMINATED` (no longer employed). Transition into `TERMINATED` populates the driver's `terminatedAt` date via the **Termination transition** rule, mirroring the **Retirement transition** rule on vehicles.

**Geofence** is a polygon on the map representing a meaningful region: the depot, a customer site, a restricted zone, or a route corridor. GPS events crossing the boundary of a geofence are recorded and may trigger logic (alerts, automatic state transitions). Geofences are stored in PostGIS as polygon geometries.

**Job** is a contract or engagement with a customer. A job consists of one or more trips. Example: "Haul aggregate from quarry X to construction site Y for two weeks" is a job; each individual round-trip is a trip on that job. The persisted Job row carries `jobNumber` (unique, of the form `JOB-YYYY-NNNNN`; the generator landed with iter 18 — server-side, derived from the current UTC year and the highest existing per-year sequence + 1, retried up to 3 times on `P2002` so a concurrent insert cannot collide deterministically; `jobNumber` is immutable post-create and the `PATCH` schema rejects it via `.strict()`), `customerId` (FK Restrict to Customer — deleting a customer that has any Job is blocked at the DB with Postgres 23503 / Prisma `P2003`, mapped to HTTP 409, the live exercise of the forward-compatible delete-blocker the Customers iter-16 write path wired; `customerId` is also immutable post-create — the `PATCH` schema rejects it), free-text `description`, `status` (the enum `job.status`: `PLANNED` / `IN_PROGRESS` / `COMPLETED` / `CANCELLED`), nullable `scheduledStartDate` / `scheduledEndDate` / `actualStartDate` / `actualEndDate` (each pair enforces end ≥ start as a service-layer cross-field rule that re-runs against the merged shape on `PATCH`), nullable `notes`, and `createdById` (FK Restrict to User, populated from the authenticated session — never accepted from the request body). Iter 17 shipped the read path (schema, migration, `GET /api/v1/jobs`, `GET /api/v1/jobs/:id`, list and detail UI); iter 18 closed the aggregate with the write path (`POST` / `PATCH` / `DELETE` + the jobNumber generator + create/edit/delete UI under `apps/web/src/app/jobs/new/` and `apps/web/src/app/jobs/[id]/edit/`) and swapped the Customer delete-dialog placeholder link to the now-live `/jobs?customerId=…` deep-link. A Trip will reference its Job by id in a later slice.

**Lease-taker** is a party who has rented or leased a vehicle for a period and operates it independently of FleetCo's direct dispatch. We bill lease-takers on a contract basis, not on a per-trip basis. Lease-takers are distinct from customers.

**licenseClass** is the enum classifying a driver by the category of Nepali driving licence they hold, as defined by Nepal's Department of Transport Management (DoTM). Phase 1 values cover the four categories relevant to heavy-construction haulage: `LMV` (Light Motor Vehicle — light four-wheelers up to ~7.5 tonnes GVW such as pickups and small utility trucks), `HMV` (Heavy Motor Vehicle — medium trucks above the LMV threshold, the common cargo class), `HTV` (Heavy Transport Vehicle — articulated trucks and tractor-trailers used for the heaviest cargo loads), and `HPMV` (Heavy Passenger Motor Vehicle — buses and other large passenger vehicles, kept in scope because the same operator endorsement applies). Categories outside this set (HGMV, motorcycle classes, special-equipment endorsements) may be added in a later slice; introducing them requires an ADR because they widen the operator's compliance surface.

**Odometer** is the integer kilometer reading on a vehicle's distance counter. FleetCo tracks two odometer values per vehicle: `odometerStartKm` (the reading at acquisition, used as the baseline for lifetime distance) and `odometerCurrentKm` (the most recent reading). Lifetime kilometers for a vehicle is `current − start`. Odometer values are stored as integers (no fractional kilometers); fractional distances belong on trip-level fields where precision matters. As of Phase 1 iter 11, `odometerCurrentKm` is updated automatically when a Trip transitions into `COMPLETED`: the service-layer `TripsService.update` runs the trip write plus a conditional `vehicle.update({ odometerCurrentKm })` inside a single Prisma interactive transaction, so the two rows commit or roll back together. The bump fires only when the trip's `endOdometerKm` is strictly greater than the vehicle's current value — a backdated correction trip whose reading is lower than the current value records the trip's history but does NOT move the vehicle's odometer backwards. Operator manual editing of `odometerCurrentKm` on the Vehicle edit form remains supported as the compensating action when (a) a vehicle's odometer needs to be corrected independently of trips and (b) when "rolling back" the odometer after a mistakenly-completed trip — the auto-update path is one-way (once forward, stays forward); the system does not unwind the bump if the COMPLETED trip is later deleted or its status is unwound by an operator. The previous behavior — `odometerCurrentKm` only updated by hand on the Vehicle edit form — applied through iter 10; iter 11 closed the gap that iter-10's cross-slice "Recent trips" sections had made visible (a vehicle's detail page showed it had trips, but its odometer field drifted behind the underlying odometer-end events).

**Retirement transition** is the rule that links a Vehicle's `vehicle.status` to its `retiredAt` date. When a vehicle's status transitions into `RETIRED` or `SOLD`, `retiredAt` is set automatically (to the date the client passed, if any, otherwise to `now()`). When the status transitions back out of `RETIRED`/`SOLD` to `ACTIVE` or `IN_MAINTENANCE`, `retiredAt` is cleared. An explicit `retiredAt` value supplied by the client always wins over the derived value, supporting unusual but legitimate cases such as backfilling a historical retirement date or recording a sold-then-bought-back vehicle. The rule is applied in `VehiclesService.update` at `apps/api/src/modules/vehicles/vehicles.service.ts`. Iter 2 introduced this rule alongside the PATCH endpoint.

**Termination transition** is the rule that links a Driver's `driver.status` to its `terminatedAt` date. When a driver's status transitions into `TERMINATED`, `terminatedAt` is set automatically (to the date the client passed, if any, otherwise to `now()`). When the status transitions out of `TERMINATED` back to `ACTIVE`/`ON_LEAVE`/`SUSPENDED`, `terminatedAt` is cleared. An explicit `terminatedAt` value supplied by the client always wins over the derived value, supporting unusual but legitimate cases such as backdating a termination or correcting a historical record. The rule is applied in `DriversService.update` at `apps/api/src/modules/drivers/drivers.service.ts` and mirrors the **Retirement transition** rule on vehicles. Iter 6 introduced this rule at the service layer; iter 7 exposed it over the `PATCH /api/v1/drivers/:id` endpoint.

**Tipper** is a truck with a hydraulic dump body, common in construction haulage. Tippers are a vehicle type within the fleet.

**Trip** is the central aggregate of the FleetCo domain. One trip is one contiguous use of one vehicle by one driver for one job, with a start odometer reading, an end odometer reading, a start time, an end time, and route data accumulated during the trip. See ADR-0003 for why the Trip is the central aggregate. The persisted Trip row carries `vehicleId` (FK Restrict to Vehicle), `driverId` (FK Restrict to Driver), `status` (the enum `trip.status`), nullable `startedAt` and `endedAt`, nullable integer `startOdometerKm` and `endOdometerKm`, free-form `notes`, and `createdById` (FK Restrict to User). The FK delete policy is Restrict on all three references: deleting a vehicle or driver that participates in any Trip is blocked by the database with Postgres error 23503 (Prisma `P2003`); this is the iter-8 baseline that the iter-9 write path will translate into a friendly HTTP 409. Iter 8 shipped the read path (schema, migration, `GET /api/v1/trips`, `GET /api/v1/trips/:id`, list and detail UI). Iter 9 ships the write path (`POST` / `PATCH` / `DELETE`, plus create / edit / cancel UI).

**trip.status** is the enum tracking the lifecycle stage of a single Trip. Values are `PLANNED` (the trip is recorded but not yet started — common when dispatching ahead of time; `startedAt` and the odometer fields remain null), `IN_PROGRESS` (the trip has started and is currently underway; `startedAt` and `startOdometerKm` are set, `endedAt` and `endOdometerKm` are null), `COMPLETED` (the trip finished normally; all four start/end fields are set and `endOdometerKm >= startOdometerKm`), and `CANCELLED` (the trip was abandoned at any stage; the start fields may or may not be set depending on whether the cancellation happened before the trip started). The iter-9 write path will validate legal transitions (no jumping from `PLANNED` directly to `COMPLETED` without going through `IN_PROGRESS`) in service-layer logic mirroring the **Retirement transition** and **Termination transition** rules.

**Vehicle** is a registered asset in the fleet: a truck, a tipper, an excavator, a loader, a grader, or other heavy-construction equipment. Vehicles have a Nepali commercial registration number (unique across the fleet), a kind (the enum `vehicle.kind`), a make and model, a year of manufacture, a status (the enum `vehicle.status`), odometer readings (see `odometer`), an acquisition date, and an optional retirement date. Bluebook, insurance, and route-permit metadata are persisted on Vehicle as of Phase 1 iter 14 (all nullable columns); Bishesh Anumati remains deferred to a later slice. Vehicle records are classified Tier 3 (operational business data) per ADR-0013. Vehicle is the foundation aggregate for Trips per ADR-0003 — every Trip references one Vehicle by id.

**vehicle.kind** is the enum classifying a vehicle by chassis type. Phase 1 values are `TRUCK`, `TIPPER`, `EXCAVATOR`, `LOADER`, `GRADER`, and `OTHER`. `OTHER` exists so an unusual asset can be registered without forcing a schema change; future slices may promote frequent `OTHER` values to their own enum entries.

**vehicle.status** is the enum tracking a vehicle's operational state. Values are `ACTIVE` (default; available for trips), `IN_MAINTENANCE` (off-road for service), `RETIRED` (permanently out of service), and `SOLD` (no longer owned by FleetCo). Transition to `RETIRED` or `SOLD` populates the vehicle's `retiredAt` date.

**Vendor** is a party that FleetCo pays: a fuel station, a repair shop, a parts supplier. Vendors are distinct from customers (whom FleetCo bills) and from lease-takers (whom FleetCo also bills, but on a contract basis).

## Compliance vocabulary (Nepal-specific)

**BS** is the abbreviation for Bikram Sambat, the Nepali calendar. The Nepali fiscal year runs roughly from mid-July to mid-July (Shrawan to Ashadh). FleetCo stores dates internally in ISO 8601 (Gregorian) and renders Bikram Sambat dates for users where appropriate.

**ICAN** is the Institute of Chartered Accountants of Nepal, the regulator for accountants and the source of accounting standards relevant to FleetCo's eventual accounting integrations.

**IRD** is Nepal's Inland Revenue Department, where tax filings happen. FleetCo's accounting outputs are designed to be compatible with IRD requirements (this is a Phase 4 concern, not a Phase 0 or Phase 1 concern).

**Insurance (तेस्रो पक्ष / comprehensive)** in the Nepali context refers to either third-party insurance (mandatory) or comprehensive insurance (optional). Both have expiries. FleetCo tracks both kinds and triggers reminders before expiry. As of Phase 1 iter 14, persisted on Vehicle as `insurer`, `insurancePolicyNumber`, `insuranceType` (enum `THIRD_PARTY` | `COMPREHENSIVE`), and `insuranceExpiresAt` — a single-row model (one active policy per vehicle); a vehicle carrying both types simultaneously is rare in Nepali heavy-fleet practice and not in scope. Phase 3 reminders will key off `insuranceExpiresAt`.

**OCR** is the Office of the Company Registrar, where company-level filings happen. Distinct from IRD.

**PAN / VAT** are Permanent Account Number and Value Added Tax registration, both required for businesses in Nepal.

**Route Permit** is permission for a goods or passenger vehicle to operate on specific routes. Route permits are time-bound and trigger compliance reminders when expiry approaches. As of Phase 1 iter 14, persisted on Vehicle as `routePermitNumber` and `routePermitExpiresAt` (both nullable). Phase 3 reminders will key off `routePermitExpiresAt`.

## Money vocabulary

**NPR / रू** is the Nepalese Rupee, FleetCo's default currency. All money is stored as integer paisa (1 NPR = 100 paisa) to avoid floating-point errors. Display formatting renders rupees from paisa.

**Lease income** is money earned from lease-takers on contract.

**Per-vehicle profit and loss** is the profit and loss attributable to one specific vehicle for a specified period: the trip-revenue for that vehicle minus all costs (fuel, expenses, allocated maintenance, allocated overhead) for that vehicle.

**Trip revenue** is money billed to a customer for trips on a job.

## Technical vocabulary

**ADR** stands for Architecture Decision Record. An ADR is a short, append-only document capturing one architectural decision: its context, the decision itself, alternatives considered, consequences, and the signal that would prompt revisiting the decision. ADRs live in `docs/architecture/decisions/`. See `template.md` for the format.

**better-auth** is the TypeScript-first authentication library FleetCo uses across the NestJS API and Next.js admin web. Sessions are database-stored and opaque-cookie-identified rather than JWT-based. See ADR-0015.

**BullMQ** is a Redis-backed job queue library for Node.js. FleetCo uses BullMQ for background work that should not block the API: GPS ingestion (in Phase 2), notifications, report generation.

**DTO (Data Transfer Object)** is a typed shape used at the API boundary, distinct from the database row shape. DTOs let the API evolve its public contracts without forcing the database schema to evolve in lockstep.

**Geospatial** describes anything involving coordinates, distances, or polygons. In FleetCo, geospatial concerns are handled by PostGIS.

**Idempotent** describes an operation that produces the same result whether called once or many times. Idempotency matters for retries: an idempotent operation can be safely retried after a network failure without risking duplicate effects.

**Legal status transition** is the rule, enforced at the service layer rather than at the database, that constrains which status changes are permitted on a state-machine field. As of Phase 1 iter 9, FleetCo applies legal-status-transition rules in two places: (a) the Vehicle aggregate's `status` field follows the "retirement transition" rule documented in `apps/api/src/modules/vehicles/vehicles.service.ts` (status→RETIRED/SOLD auto-stamps `retiredAt`; status→ACTIVE/IN_MAINTENANCE clears it); (b) the Trip aggregate's `status` field follows the transition matrix `PLANNED → IN_PROGRESS → COMPLETED`, with `CANCELLED` reachable from any non-terminal state and self-transitions permitted (the matrix lives in `apps/api/src/modules/trips/trips.schemas.ts:TRIP_STATUS_TRANSITIONS` and the predicate in `isLegalTripStatusTransition`). An illegal transition is rejected by the service with `BadRequestException` (HTTP 400) before the write reaches Prisma. Cross-field rules layered on top — IN_PROGRESS requires `startedAt` and `startOdometerKm`; COMPLETED requires all four of `startedAt`, `endedAt`, `startOdometerKm`, `endOdometerKm` with `endedAt >= startedAt` and `endOdometerKm >= startOdometerKm` — are validated against the merged shape (current row + patch) inside the service, because Zod's `superRefine` only sees the partial PATCH body. The matrix is not encoded as a database constraint because the constraint is a small per-aggregate detail that changes faster than schema migrations are comfortable to ship; future aggregates (e.g., a Maintenance ticket) that introduce their own state machines will mirror this pattern.

**Modular monolith** is the architecture FleetCo uses: one deployable application with strict internal module boundaries enforced by code review. See ADR-0001.

**N+1 query** is a performance anti-pattern in which loading N items triggers N additional queries instead of a single batched one. N+1 queries are forbidden; loading N items requires either eager loading or a batched query.

**PostGIS** is a PostgreSQL extension for geospatial data and queries. FleetCo uses PostGIS for geofences, GPS pings (Phase 2), and any spatial queries.

**RBAC (Role-Based Access Control)** is a permission model in which permissions are grouped into roles, and users are assigned roles. RBAC is deferred until Phase 2 in FleetCo, when office staff are introduced as a user role distinct from the CEO.

**Session-based authentication** is an authentication model in which a server issues a session record (stored in a database or cache), and the client holds an opaque cookie that references the session. Distinct from token-based authentication (such as JWT), in which the client holds a self-contained signed token. FleetCo uses session-based authentication because the admin web does not need cross-domain token-based auth, sessions are revocable without a key-rotation event, and the server-side session record is the natural place to attach role and permission state as Phase 2's RBAC arrives. See ADR-0015.

**shadcn-ui** is the base design system FleetCo customizes from: a copy-paste-not-install component library built on Radix UI primitives and Tailwind CSS, shipping a Vercel-derived aesthetic. Component implementations are copied into `apps/web` and owned in-tree rather than imported as a versioned dependency; FleetCo customizations (NPR formatting, BS-calendar widgets, Devanagari fallback, ERP density) layer on top. See ADR-0016 and ADR-0007 for the design-folder discipline that consumes from it.

**Soft delete** is the pattern of marking a row as deleted (typically via a `deletedAt` timestamp) and filtering it out of queries, rather than physically removing it. Soft delete preserves referential integrity for related rows and supports recovery from accidental deletion. As of Phase 1 iter 9, FleetCo does NOT implement soft delete: the Vehicle, Driver, and Trip DELETE endpoints hard-delete the row. Iter 8 introduced the Trip aggregate, which references Vehicle and Driver by id with FK delete policy `Restrict`; iter 9 closed the loop by mapping the resulting Prisma `P2003` (FK constraint violation) to `ConflictException` (HTTP 409) with a friendly per-aggregate message naming the count of referencing trips (e.g. `"Cannot delete vehicle: 3 trips reference this vehicle."`). Iter 10 added the operator-facing affordance: when `DeleteVehicleDialog` / `DeleteDriverDialog` surface that 409, the inline error block also renders a "View N trips" deep-link to the filtered trips list (`/trips?vehicleId=<id>` or `/trips?driverId=<id>`) so the operator can pivot from "I can't delete this" to "let me see what's blocking" without leaving the dialog mental model. The block-when-referenced policy is the project's chosen approach over true soft delete: a vehicle or driver with historical trips is a different entity from a never-existed one, and the audit value of `deletedAt` is lower than the simplicity of "the row exists or it doesn't." A follow-up that adds `deletedAt` to any aggregate would be a separate ADR, prompted by an explicit audit-trail or recovery requirement.

**Vertical slice** is the development pattern FleetCo uses: each unit of work is one user-facing workflow built end-to-end (schema, migration, service, API, UI, test) rather than one layer of the system across all features. See ADR-0006.

## Memory architecture vocabulary

**Episodic memory** in the project's memory architecture is memory of specific events and decisions. It lives in `docs/architecture/decisions/`.

**Operational memory** is memory of measurements and operational records taken on regular cadences. It lives in `docs/operations/`. The DORA metrics file is updated weekly; SLO compliance reports are computed monthly.

**Perceptual memory** is memory of what things should look and feel like. It lives in `docs/design/`.

**Procedural memory** is memory of how things are done. It lives in `docs/runbook/` and `BOOTSTRAP.md`.

**Prospective memory** is memory of intentions held for future execution. It lives in `docs/product/roadmap.md`, `docs/CURRENT_PHASE.md`, and `docs/tech-debt.md`.

**Semantic memory** is memory of what words mean. It lives in this glossary.

**Substrate** in the memory architecture refers to the medium in which memory is stored. FleetCo's substrate is the filesystem under git version control, with files organized in a hierarchical directory structure. See `docs/architecture/memory-architecture.md`.

## Delivery operating model vocabulary

**Change failure rate** is one of the four canonical DORA metrics. It is the percentage of production deployments that result in a customer-impacting failure (detected via Sentry error spike or manual rollback within 24 hours of the deploy). FleetCo's Phase 1 target is under 15 percent measured monthly. See ADR-0010.

**Deployment frequency** is one of the four canonical DORA metrics. It is the rate at which the team deploys to production, measured weekly as deploys per working day. FleetCo's Phase 1 target is at least one production deploy per working day on average.

**DORA** stands for DevOps Research and Assessment, the research program (now part of Google) that produces the annual State of DevOps reports and that defined the four canonical delivery metrics plus the rework rate. See ADR-0010 for FleetCo's commitment to measure these metrics.

**Error budget** is the quantity of permitted bad events over an SLO measurement window, computed as 100 percent minus the SLO. For FleetCo's 99.0 percent availability SLO over a 28-day rolling window, the error budget is approximately 7 hours of unavailability per 28 days. See ADR-0011.

**Failed deployment recovery time** is one of the four canonical DORA metrics. It is the time between a detected deploy failure and the deploy that restored service. FleetCo's Phase 1 target is under 2 hours at the 90th percentile.

**Lead time for changes** is one of the four canonical DORA metrics. It is the median time from PR merge to production deploy completion. FleetCo's Phase 1 target is under 24 hours.

**Rework rate** is the fifth DORA metric, formalized in 2025. It is the percentage of merged PRs that have to be revisited within 14 days because they did not work as intended. FleetCo's Phase 1 target is under 25 percent measured monthly.

**SBOM** stands for Software Bill of Materials. It is a structured list of all dependencies in a software artifact, used for supply-chain security analysis and vulnerability response. FleetCo generates a CycloneDX SBOM for every production build. See ADR-0012.

**SEV1, SEV2, SEV3** are the three incident severity levels in FleetCo's classification. SEV1 is a customer-impacting incident affecting core business operations (trip creation, fuel logging). SEV2 is a customer-impacting incident affecting non-core modules or a degraded but functional core module. SEV3 is a non-customer-impacting incident (logging gap, backup verification failure, minor UI defect). Each level has defined response expectations. See ADR-0011 and `docs/runbook/incident-response.md`.

**SLI (Service Level Indicator)** is a measurement of something users care about, typically expressed as the ratio of good events to valid events. FleetCo's two SLIs are API availability (the percentage of HTTP requests returning 2xx or 3xx within 500 milliseconds) and trip-creation success (the percentage of trip-creation operations completing end-to-end without user-visible error). See ADR-0011.

**SLO (Service Level Objective)** is a target on an SLI over a defined time window. FleetCo's SLOs are 99.0 percent for both indicators over a rolling 28-day window. See ADR-0011.

**SRE (Site Reliability Engineering)** is the body of practice developed at Google for running production software systems with measurable reliability targets and operational discipline. FleetCo adopts a minimum viable SRE framework appropriate to a one-person operation. See ADR-0011.

## Data and security vocabulary

**Data classification tier** is a categorization of data by sensitivity. FleetCo uses four tiers per ADR-0013. Tier 1 is administrative and authentication data. Tier 2 is personally identifying information. Tier 3 is operational business data. Tier 4 is non-sensitive metadata. The tier determines logging, encryption, and access rules.

**Recovery Point Objective (RPO)** is the maximum acceptable data loss in a disaster, measured as a time window. FleetCo's RPO is 24 hours, meaning the maximum acceptable data loss is one day's worth of data.

**Recovery Time Objective (RTO)** is the maximum acceptable time for service restoration after a disaster. FleetCo's RTO is 4 hours for the API and admin web, and 24 hours for the driver app (in Phase 2).

**Secrets scanning** is the practice of scanning code (and git history) for credential patterns that should never be committed. FleetCo uses GitHub native secrets scanning per ADR-0012.

**Static Application Security Testing (SAST)** is automated analysis of source code for security vulnerabilities. FleetCo uses Semgrep with the OWASP and security-audit rulesets per ADR-0012.

**Software Composition Analysis (SCA)** is the practice of identifying and tracking known-vulnerable dependencies in a project. FleetCo uses Dependabot for SCA per ADR-0012.

**Tier 1 / Tier 2 / Tier 3 / Tier 4** see "Data classification tier" above.
