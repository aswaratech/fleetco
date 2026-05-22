# Current phase

**Phase 1 — The Spine**

Phase 0 (Kickoff) is complete: the monorepo scaffold, NestJS API skeleton, Next.js admin skeleton, Postgres + Redis via Docker Compose, Prisma baseline + auth migration, CI on GitHub Actions, the security baseline jobs from ADR-0012, the baseline documentation, the agent guardrails, the orchestration loop (ADR-0022), and basic auth scaffolding for a single admin user are all in place.

Phase 1 replaces spreadsheets and paper for daily fleet operations. The system in Phase 1 is web admin only, with the CEO as the only user. The phase is built as a sequence of vertical slices per ADR-0006 (schema → migration → service → API → UI → test), in this order: Vehicles, Drivers, Customers, Jobs, Trips, Fuel logs, Expense logs, Reports v1. Operational milestones (first production deploy, first restore-from-backup test, SLI instrumentation, OpenTelemetry, performance budget) are interleaved across the same window.

The Vehicles slice is in flight (read path landed in this PR; writes and tests follow in iter 2). See `docs/product/roadmap.md` §"Phase 1 — The Spine" for the full Phase 1 scope and operational commitments. When the last Phase 1 slice (Reports v1) ships and the CEO is using FleetCo daily, this file is updated to indicate Phase 2 is active.
