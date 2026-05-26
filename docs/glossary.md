# Glossary

This is the project's semantic memory: the place where words have agreed meanings. Add new terms here on first use. The glossary is alphabetical within sections. Entries are not silently removed; if a term changes meaning over time, the change is documented in the entry rather than its history erased.

## Fleet and operations vocabulary

**Bishesh Anumati (विशेष अनुमति)** is the Nepali term for a special permit, often required to operate certain heavy vehicles or to operate on certain routes. It is one of the compliance documents tracked by the system, and its expiry triggers a reminder.

**Bluebook (नीलो किताब)** is the vehicle registration certificate issued by Nepal's Department of Transport Management. It is called the Bluebook because of the color of its cover. Every vehicle in FleetCo has a Bluebook number and metadata, and Bluebook expiry triggers compliance reminders.

**Customer** is a party who hires FleetCo's vehicles for jobs. A customer is distinct from a lease-taker. A customer engages FleetCo to do work; a lease-taker rents vehicles to do their own work.

**Driver** is an employed or contracted person who operates vehicles on trips. Drivers have license metadata (`licenseNumber`, `licenseClass`, `licenseExpiresAt`), Tier 2 PII (`fullName`, `phone`, optional `dateOfBirth`), and an employment status (`driver.status`). Drivers are participants in trips; they are not the central aggregate. Iter 6 shipped the read path (schema, list and detail API, list and detail UI). Iter 7 shipped the write path (`POST` / `PATCH` / `DELETE /api/v1/drivers`, plus create / edit / delete UI under `apps/web/src/app/drivers/`).

**driver.status** is the enum tracking a driver's employment state. Values are `ACTIVE` (default; eligible to be assigned to trips), `ON_LEAVE` (temporarily unavailable but still employed), `SUSPENDED` (administratively withheld from trips pending a decision), and `TERMINATED` (no longer employed). Transition into `TERMINATED` populates the driver's `terminatedAt` date via the **Termination transition** rule, mirroring the **Retirement transition** rule on vehicles.

**Geofence** is a polygon on the map representing a meaningful region: the depot, a customer site, a restricted zone, or a route corridor. GPS events crossing the boundary of a geofence are recorded and may trigger logic (alerts, automatic state transitions). Geofences are stored in PostGIS as polygon geometries.

**Job** is a contract or engagement with a customer. A job consists of one or more trips. Example: "Haul aggregate from quarry X to construction site Y for two weeks" is a job; each individual round-trip is a trip on that job.

**Lease-taker** is a party who has rented or leased a vehicle for a period and operates it independently of FleetCo's direct dispatch. We bill lease-takers on a contract basis, not on a per-trip basis. Lease-takers are distinct from customers.

**licenseClass** is the enum classifying a driver by the category of Nepali driving licence they hold, as defined by Nepal's Department of Transport Management (DoTM). Phase 1 values cover the four categories relevant to heavy-construction haulage: `LMV` (Light Motor Vehicle — light four-wheelers up to ~7.5 tonnes GVW such as pickups and small utility trucks), `HMV` (Heavy Motor Vehicle — medium trucks above the LMV threshold, the common cargo class), `HTV` (Heavy Transport Vehicle — articulated trucks and tractor-trailers used for the heaviest cargo loads), and `HPMV` (Heavy Passenger Motor Vehicle — buses and other large passenger vehicles, kept in scope because the same operator endorsement applies). Categories outside this set (HGMV, motorcycle classes, special-equipment endorsements) may be added in a later slice; introducing them requires an ADR because they widen the operator's compliance surface.

**Odometer** is the integer kilometer reading on a vehicle's distance counter. FleetCo tracks two odometer values per vehicle: `odometerStartKm` (the reading at acquisition, used as the baseline for lifetime distance) and `odometerCurrentKm` (the most recent reading, updated by trip-end events). Lifetime kilometers for a vehicle is `current − start`. Odometer values are stored as integers (no fractional kilometers); fractional distances belong on trip-level fields where precision matters.

**Retirement transition** is the rule that links a Vehicle's `vehicle.status` to its `retiredAt` date. When a vehicle's status transitions into `RETIRED` or `SOLD`, `retiredAt` is set automatically (to the date the client passed, if any, otherwise to `now()`). When the status transitions back out of `RETIRED`/`SOLD` to `ACTIVE` or `IN_MAINTENANCE`, `retiredAt` is cleared. An explicit `retiredAt` value supplied by the client always wins over the derived value, supporting unusual but legitimate cases such as backfilling a historical retirement date or recording a sold-then-bought-back vehicle. The rule is applied in `VehiclesService.update` at `apps/api/src/modules/vehicles/vehicles.service.ts`. Iter 2 introduced this rule alongside the PATCH endpoint.

**Termination transition** is the rule that links a Driver's `driver.status` to its `terminatedAt` date. When a driver's status transitions into `TERMINATED`, `terminatedAt` is set automatically (to the date the client passed, if any, otherwise to `now()`). When the status transitions out of `TERMINATED` back to `ACTIVE`/`ON_LEAVE`/`SUSPENDED`, `terminatedAt` is cleared. An explicit `terminatedAt` value supplied by the client always wins over the derived value, supporting unusual but legitimate cases such as backdating a termination or correcting a historical record. The rule is applied in `DriversService.update` at `apps/api/src/modules/drivers/drivers.service.ts` and mirrors the **Retirement transition** rule on vehicles. Iter 6 introduced this rule at the service layer; iter 7 exposed it over the `PATCH /api/v1/drivers/:id` endpoint.

**Tipper** is a truck with a hydraulic dump body, common in construction haulage. Tippers are a vehicle type within the fleet.

**Trip** is the central aggregate of the FleetCo domain. One trip is one contiguous use of one vehicle by one driver for one job, with a start odometer reading, an end odometer reading, a start time, an end time, and route data accumulated during the trip. See ADR-0003 for why the Trip is the central aggregate.

**Vehicle** is a registered asset in the fleet: a truck, a tipper, an excavator, a loader, a grader, or other heavy-construction equipment. Vehicles have a Nepali commercial registration number (unique across the fleet), a kind (the enum `vehicle.kind`), a make and model, a year of manufacture, a status (the enum `vehicle.status`), odometer readings (see `odometer`), an acquisition date, and an optional retirement date. Bluebook, insurance, and route-permit metadata are added in later slices; iter 1 covers the core record. Vehicle records are classified Tier 3 (operational business data) per ADR-0013. Vehicle is the foundation aggregate for Trips per ADR-0003 — every Trip references one Vehicle by id.

**vehicle.kind** is the enum classifying a vehicle by chassis type. Phase 1 values are `TRUCK`, `TIPPER`, `EXCAVATOR`, `LOADER`, `GRADER`, and `OTHER`. `OTHER` exists so an unusual asset can be registered without forcing a schema change; future slices may promote frequent `OTHER` values to their own enum entries.

**vehicle.status** is the enum tracking a vehicle's operational state. Values are `ACTIVE` (default; available for trips), `IN_MAINTENANCE` (off-road for service), `RETIRED` (permanently out of service), and `SOLD` (no longer owned by FleetCo). Transition to `RETIRED` or `SOLD` populates the vehicle's `retiredAt` date.

**Vendor** is a party that FleetCo pays: a fuel station, a repair shop, a parts supplier. Vendors are distinct from customers (whom FleetCo bills) and from lease-takers (whom FleetCo also bills, but on a contract basis).

## Compliance vocabulary (Nepal-specific)

**BS** is the abbreviation for Bikram Sambat, the Nepali calendar. The Nepali fiscal year runs roughly from mid-July to mid-July (Shrawan to Ashadh). FleetCo stores dates internally in ISO 8601 (Gregorian) and renders Bikram Sambat dates for users where appropriate.

**ICAN** is the Institute of Chartered Accountants of Nepal, the regulator for accountants and the source of accounting standards relevant to FleetCo's eventual accounting integrations.

**IRD** is Nepal's Inland Revenue Department, where tax filings happen. FleetCo's accounting outputs are designed to be compatible with IRD requirements (this is a Phase 4 concern, not a Phase 0 or Phase 1 concern).

**Insurance (तेस्रो पक्ष / comprehensive)** in the Nepali context refers to either third-party insurance (mandatory) or comprehensive insurance (optional). Both have expiries. FleetCo tracks both kinds and triggers reminders before expiry.

**OCR** is the Office of the Company Registrar, where company-level filings happen. Distinct from IRD.

**PAN / VAT** are Permanent Account Number and Value Added Tax registration, both required for businesses in Nepal.

**Route Permit** is permission for a goods or passenger vehicle to operate on specific routes. Route permits are time-bound and trigger compliance reminders when expiry approaches.

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

**Modular monolith** is the architecture FleetCo uses: one deployable application with strict internal module boundaries enforced by code review. See ADR-0001.

**N+1 query** is a performance anti-pattern in which loading N items triggers N additional queries instead of a single batched one. N+1 queries are forbidden; loading N items requires either eager loading or a batched query.

**PostGIS** is a PostgreSQL extension for geospatial data and queries. FleetCo uses PostGIS for geofences, GPS pings (Phase 2), and any spatial queries.

**RBAC (Role-Based Access Control)** is a permission model in which permissions are grouped into roles, and users are assigned roles. RBAC is deferred until Phase 2 in FleetCo, when office staff are introduced as a user role distinct from the CEO.

**Session-based authentication** is an authentication model in which a server issues a session record (stored in a database or cache), and the client holds an opaque cookie that references the session. Distinct from token-based authentication (such as JWT), in which the client holds a self-contained signed token. FleetCo uses session-based authentication because the admin web does not need cross-domain token-based auth, sessions are revocable without a key-rotation event, and the server-side session record is the natural place to attach role and permission state as Phase 2's RBAC arrives. See ADR-0015.

**shadcn-ui** is the base design system FleetCo customizes from: a copy-paste-not-install component library built on Radix UI primitives and Tailwind CSS, shipping a Vercel-derived aesthetic. Component implementations are copied into `apps/web` and owned in-tree rather than imported as a versioned dependency; FleetCo customizations (NPR formatting, BS-calendar widgets, Devanagari fallback, ERP density) layer on top. See ADR-0016 and ADR-0007 for the design-folder discipline that consumes from it.

**Soft delete** is the pattern of marking a row as deleted (typically via a `deletedAt` timestamp) and filtering it out of queries, rather than physically removing it. Soft delete preserves referential integrity for related rows and supports recovery from accidental deletion. As of Phase 1, FleetCo does NOT implement soft delete: the Vehicle aggregate's DELETE endpoint hard-deletes the row because no downstream slice references Vehicle yet. Once Trips land and reference Vehicle by id, the deletion semantics will revisit — either to a true soft delete (add `deletedAt` to the schema, filter on read) or to a block-when-referenced policy (return HTTP 409 if any Trip references the vehicle). The decision is deferred until the Trip slice is in flight and the dependency direction is known in practice; the controller comment in `apps/api/src/modules/vehicles/vehicles.controller.ts` records this plan.

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
