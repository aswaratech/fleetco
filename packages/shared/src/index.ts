// @fleetco/shared — the monorepo's pure, dependency-light shared-library home
// (CLAUDE.md §"shared libraries under packages/"). Its first real tenants are
// the two pure classifiers/formatters that the compliance/maintenance BADGE
// (apps/web) and the reminder DIGEST (apps/api, ADR-0038) must agree on byte-
// for-byte — hosted here so there is ONE copy that cannot drift (ADR-0038
// commitment 6, the load-bearing drift guard). Everything exported here is a
// pure function, type, or constant with no Nest/Next/runtime coupling, so both
// a NestJS service and a Next.js server component can import it freely.
//
// apps/web re-exports these through its own `src/lib/compliance.ts` and
// `src/lib/nepali-date.ts` so its many existing `@/lib/*` importers stay
// unchanged; apps/api imports `@fleetco/shared` directly (the reminder scan and
// the digest renderer, Program C).
export * from "./compliance";
export * from "./maintenance";
export * from "./nepali-date";
