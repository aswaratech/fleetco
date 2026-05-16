# ADR-0015: Authentication library — better-auth

- **Status:** Accepted
- **Date:** 2026-05-16
- **Decider:** Product owner (CEO)

## Context

FleetCo needs an authentication layer from Phase 0 onward. The Phase 0 deliverable is a single-admin login scaffold (Ticket 10 of the kickoff plan); from Phase 2 the auth layer must extend to role-based access control (RBAC) when office staff become a distinct user role from the CEO; from later phases it must support a driver app with mobile-friendly session handling. The architecture overview names Lucia and Auth.js as the leading candidates and commits to session-based auth rather than JWTs because the admin UI does not need cross-domain token-based auth and sessions are simpler to revoke. The architecture is a NestJS API (`apps/api`) plus a Next.js App Router admin web (`apps/web`); the auth layer therefore lives across both, with the API issuing and validating sessions and the web reading them.

The constraints in play: TypeScript end-to-end with `strict: true` and no `any` (ADR-0005); modular monolith with strict module boundaries (ADR-0001); the auth module owns sessions and the current-user concept (architecture overview); the session secret is Tier 1 data per ADR-0013 (never appears in source or logs) and lives in the production secret store. The Phase 1 auth scaffolding stores the session secret in a local `.env` (gitignored) per the kickoff plan's closing paragraph, and the production secret store decision is deferred to the not-yet-written deployment ADR (the slot reserved at ADR-0014).

The question this ADR closes: which auth library do we use?

## Decision

The authentication library for FleetCo is **`better-auth`** (https://www.better-auth.com), used as the session-based auth layer across both the NestJS API and the Next.js admin web. Sessions are server-stored (in Postgres in Phase 0–1 via better-auth's database adapter, optionally backed by Redis from Phase 2 if measurements justify the move) and identified by an opaque cookie. The Phase 0 scaffolding (Ticket 10) wires a single admin user seeded from environment variables; the user table and session table are owned by the `auth` module per architecture overview module rules.

## Alternatives considered

**Lucia.** A TypeScript-first, deliberately-minimal auth library that pioneered the "framework-agnostic session primitives" pattern in the TypeScript ecosystem. Strong type story, well-documented, broad adoption. Rejected because (a) its API surface deliberately leaves the higher-level glue (routes, middleware, framework adapters) for the application to write, which means more scaffolding code per integration; (b) the maintainer has publicly stated direction changes for the v4 line that introduce uncertainty about long-term API stability; (c) better-auth's full-stack pattern (it ships server primitives, framework adapters, client helpers, and admin features together) fits the API-plus-web shape with less custom code on our side.

**Auth.js (formerly NextAuth).** A mature, broadly-adopted auth library for the JavaScript ecosystem, originally Next.js-centric and now extending to other frameworks. Largest ecosystem of provider integrations. Rejected because (a) its Next.js-centric heritage means the cleanest patterns assume the auth layer lives in Next.js routes, which forces awkward duplication when the NestJS API also needs to authenticate the same session — better-auth's API-first session model maps cleanly onto NestJS without that mismatch; (b) Auth.js's session handling has historically prioritized JWT-style tokens with database sessions as a secondary mode, while we want database sessions as the primary mode; (c) its provider catalog is overkill for FleetCo, which has a single internal admin and a future driver app, not a multi-provider OAuth surface.

**Rolling our own.** Considered and rejected. Auth is a category where novel bugs are security bugs; the cost of reinventing primitives that battle-tested libraries already solve is not justified by any FleetCo-specific need. Documented as rejected so a future session does not propose it under the cover of "just simpler."

## Consequences

What this makes easier: a single TypeScript-typed session story across `apps/api` and `apps/web`, with the same library's primitives on both sides; strong types align with the no-`any` discipline; the library ships RBAC primitives that the Phase 2 RBAC introduction (office staff role) can build on without rewriting the auth module; database sessions are revocable in a way JWTs are not, which matters when the operational substrate is a small single-admin system where one bad-token leak should be containable without a key rotation.

What this makes harder: better-auth has a smaller community than Lucia or Auth.js, which means fewer Stack Overflow hits, fewer pre-existing tutorials, and less AI-agent training mass — work that is unusual or edge-case will require reading primary docs more often than alternatives would. The library is also younger, which means a higher rate of breaking changes across minor versions than a mature alternative would impose.

Costs we accept: less battle-tested than Lucia or Auth.js. We mitigate by (a) pinning to a specific minor version in `package.json` and treating major upgrades as ADR-revisit events rather than routine version bumps; (b) keeping the auth module's public service interface narrow so a future library swap rewrites only the implementation, not every caller; (c) writing module-boundary contract tests for the auth interface so a swap is detectable as a behavior change.

The auth module's public interface is the only surface other modules see (per the modular monolith rules in ADR-0001). If we ever swap libraries, the implementation behind the interface changes but no other module is touched. This is the architectural insulation that makes the "less battle-tested" cost a recoverable cost rather than a one-way door.

## Revisit when

Any of: (a) a sustained pattern of reliability friction — recurring auth bugs that the library's API surface makes hard to debug or fix — over a one-month window; (b) a security incident that traces to a library defect the maintainer is slow to address; (c) the Phase 2 RBAC requirements (office staff as a distinct role with row-level scoping) turn out to be poorly supported by better-auth's role/permission primitives; (d) the library is sunset, abandoned, or undergoes a project-fork that splits its community; (e) a major-version upgrade introduces breaking changes that materially affect FleetCo's auth code.
