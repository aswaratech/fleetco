# rollback

> **STATUS: DRAFT — written from ADR-0014, not yet executed.** Promote to `STATUS: ACTIVE` with a real "Last verified" date once a rollback has actually been performed or deliberately rehearsed. See `docs/runbook/README.md` and `docs/architecture/decisions/0014-deployment-single-vps.md`.

## When this procedure applies

A deploy made production worse — a Sentry error spike, `/health/ready` failing, a core operation (trip creation, fuel/expense logging) broken or producing wrong data, or any SEV1/SEV2 (ADR-0011) traced to the latest deploy. Use this to return to the last-known-good version fast and diagnose afterward. Because images are SHA-tagged in GHCR, rollback is **redeploying the previous tag — no rebuild** (ADR-0014 §8).

Placeholders: `<vps-host>`, `<domain>`, `<good-sha>` (previous known-good image tag), `<bad-sha>` (the tag being backed out).

## Procedure

1. Identify `<good-sha>` — the image tag from the prior good deploy (check `docs/operations/dora-metrics.md`, the GHCR tag list, or the previous merge on `main`).
2. **Preferred:** re-run the `deploy` workflow with input `<good-sha>`. **Manual equivalent:** `ssh <vps-host>`; `cd /opt/fleetco`; `export IMAGE_TAG=<good-sha>`; `docker compose -f docker-compose.prod.yml pull`; `docker compose -f docker-compose.prod.yml up -d`.
3. **If `<bad-sha>` introduced a migration that applied successfully**, the schema has already advanced and an app-only rollback does NOT revert it. (A migration that _failed mid-apply_ is a different case — an image rollback cannot fix it; see the "`prisma migrate deploy` fails" entry in `deploy.md`, which routes it to `restore-from-backup.md`.) Decide:
   - New schema is backward-compatible with `<good-sha>` (additive columns/tables) → the app rollback is sufficient; proceed.
   - `<good-sha>` cannot run against the new schema → this is no longer a simple rollback: escalate to `restore-from-backup.md` (restore the pre-deploy DB) and treat as SEV1.
4. Verify recovery: the liveness/readiness/admin-login smoke checks from `deploy.md`; confirm the Sentry error spike subsides.
5. Record: note the rollback in `docs/operations/dora-metrics.md` (it counts toward change-failure-rate and failed-deployment-recovery-time), and open a blameless postmortem in `docs/postmortems/` for any SEV1/SEV2 (ADR-0011).

## What can go wrong

- **No known-good previous tag** (e.g. the first deploy broke). You cannot roll back to a prior image — fix forward with a hotfix deploy, or if data is corrupt go to `restore-from-backup.md`.
- **Rolling back across a destructive migration** (a dropped/renamed column). The old image errors against the new schema — do not force it; go to restore-from-backup. (This is why migrations should avoid destructive changes without a compatibility window.)
- **The rollback image is itself stale/bad.** Step back one more tag, or fix forward.
- **Recovery dragging past the DORA target** (failed-deployment recovery < 2 h, 90th pct). Stop improvising: declare the SEV and follow `incident-response.md`.

## Last verified

Not yet verified — `DRAFT`. Replace with the date + `STATUS: ACTIVE` after the first real rollback or a deliberate rehearsal.
