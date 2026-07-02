# Runbook

This folder is the project's procedural memory: the place where operational procedures live in a form that any participant can read and execute, including a fresh AI agent in a panic at 2am.

The procedures in this folder are added as the project grows. At project start, this folder contains the README, three active procedures (business continuity, incident response, security incident response), four stub files for procedures we know we will need (deploy, rollback, restore from backup, dev setup), and a sub-folder for incident-specific procedures. Each stub will be replaced with a real procedure when the corresponding situation first arises and we work through the procedure in real time, capturing what we did so the next person does not have to figure it out from scratch.

The discipline of the runbook is that procedures are testable. A procedure that does not work is flagged as broken (with a `STATUS: BROKEN` marker at the top of the file) rather than left in place to mislead. A procedure that has not been tested in a long time is flagged as stale (with a `STATUS: STALE, last verified YYYY-MM-DD` marker) so a reader knows to verify before relying on it. Active procedures carry a `STATUS: ACTIVE` marker and a "last verified" date that is updated each time the procedure is verified.

## Active procedures

The procedure for handling production incidents lives at `docs/runbook/incident-response.md`. It references the severity classification in ADR-0011 and the postmortem discipline in `docs/postmortems/README.md`. This procedure is active from the moment Phase 1 ships and is reviewed quarterly and after every SEV1 or SEV2 incident.

The procedure for handling security incidents specifically lives at `docs/runbook/security-incident-response.md`. It is a peer of the general incident response procedure with additional steps for credential rotation, evidence preservation, and external communication. It references the security baseline in ADR-0012 and the data classification in ADR-0013.

The business continuity plan lives at `docs/runbook/business-continuity.md`. It documents the founder's commitments around degraded-mode operation, designated points of contact, credentials and access, and what happens during short, medium, and extended unavailability. The plan is reviewed at least annually and updated whenever the operational substrate changes.

The orchestration loop design lives at `docs/runbook/orchestration-loop-design.md` and the daily-operator reference lives at `docs/runbook/orchestration-loop-operator-guide.md`. These document the autonomous multi-ticket execution pattern adopted in ADR-0022: how the loop honors discipline gates, how it auto-answers mid-session questions, how it blocks destructive Bash, how it strips fabricated operator-confirmation preambles, and how the operator launches, monitors, halts, and resumes the loop via Slack. The design is verified by the 113 unit tests in `scripts/orchestration/tests/`; the operator guide is verified by running the loop end-to-end on a benign mock kickoff at the start of each program.

The API error-mapping convention lives at `docs/runbook/api-error-mapping.md`. It documents how Prisma error codes (P2002, P2003, P2025) translate to HTTP status codes (409, 404) across modules, how zod validation failures surface as 400, and how new modules should implement the mapping without inventing per-module response shapes. Introduced during the Vehicles write-path slice (iter 2) when the first unique-constraint violation needed an honest 4xx response; updated whenever the mapping table changes.

The main branch-protection ruleset lives at `docs/runbook/branch-protection.md`. It records the GitHub repository ruleset that enforces CLAUDE.md's "`main` is always green / PRs are required to merge" rules at the server layer (PR-required, no direct or force-push or deletion, the eight CI checks green) — the backstop the autonomous loop's merge authority (ADR-0022) depends on. It carries the exact required-check contexts plus a load-bearing warning to re-pull them from a live PR before applying, because a wrong context name deadlocks every future merge. Applied out-of-band by the operator (repo-admin); it is `STATUS: DRAFT` until that apply.

## Procedures we know we will need

The following procedures will be needed at known points in the project's life. We create stubs now so that the file paths exist and future PRs can fill them in rather than inventing path conventions on the fly.

The procedure for setting up a development environment from a fresh machine lives at `docs/runbook/dev-setup.md`. It will be filled in when the first non-CEO contributor (which may be an automated CI environment in Phase 0) needs to provision a workspace.

The procedure for deploying to production lives at `docs/runbook/deploy.md`. It will be filled in when the first deployment infrastructure is set up, which is a Phase 0 task or an early Phase 1 task depending on whether we deploy a "hello world" before any business features.

The procedure for rolling back a bad deployment lives at `docs/runbook/rollback.md`. It will be filled in alongside `deploy.md`, because deployment without rollback is incomplete.

The procedure for restoring from a database backup lives at `docs/runbook/restore-from-backup.md`. It will be filled in within two weeks of the first production deployment, because untested backups do not exist.

The procedure for responding to common incidents lives at `docs/runbook/incidents/`, with a separate file per incident type. The folder is empty at project start; entries will be added as incidents occur and as we learn what kinds of incidents this system produces.

## Why stubs exist before content

Creating empty stubs at project start is a deliberate choice. The alternative is to create the files only when they are needed, which sounds tidier but produces a worse outcome: when the file is needed for the first time, the person creating it has to invent the path convention on the fly, in a moment of urgency, and the convention may differ from what some future person would have chosen. By putting the stubs in place at the start, we lock in the path convention while we have time to think about it carefully, and the procedure of "open the runbook and fill in the deploy section" becomes a mechanical step rather than a creative one when the moment arrives.
