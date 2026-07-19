# rollback

> **STATUS: ACTIVE — tag-swap core deliberately rehearsed in the 2026-07-10 local dry-run (PR #226); a production target to roll back FROM exists as of the 2026-07-19 first deploy** (see §Last verified for the current on-box-image caveat). See `docs/runbook/README.md` and `docs/architecture/decisions/0014-deployment-single-vps.md`.

## When this procedure applies

A deploy made production worse — a Sentry error spike, `/health/ready` failing, a core operation (trip creation, fuel/expense logging) broken or producing wrong data, or any SEV1/SEV2 (ADR-0011) traced to the latest deploy. Use this to return to the last-known-good version fast and diagnose afterward. Because images are SHA-tagged in GHCR (CI's `push-images` job publishes `ghcr.io/aswaratech/fleetco-api:<sha>` + `…-web:<sha>` on every merge to `main`), rollback is **redeploying the previous tag — no rebuild**: point `docker-compose.prod.yml`'s `${IMAGE_TAG}` at the prior good SHA and `pull` + `up -d` (ADR-0014 §8).

Placeholders: `<vps-host>`, `<domain>`, `<good-sha>` (previous known-good image tag), `<bad-sha>` (the tag being backed out).

## Procedure

1. Identify `<good-sha>` — the image tag from the prior good deploy (check `docs/operations/dora-metrics.md`, the GHCR tag list, or the previous merge on `main`).
2. **Preferred:** re-dispatch the committed `deploy` workflow (`.github/workflows/deploy.yml`, `workflow_dispatch`) with the `sha` input set to `<good-sha>` — the same workflow that deploys forward, run with a previous good SHA (ADR-0014 §8). **Manual equivalent** (on the box): `ssh <vps-host>`; `cd /opt/fleetco`; `export IMAGE_TAG=<good-sha>`; `docker compose -f docker-compose.prod.yml pull`; `docker compose -f docker-compose.prod.yml up -d` (recreates api/web at the prior tag; postgres/redis untouched, no rebuild).
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

- **2026-07-19** — promoted to `ACTIVE` on the strength of the 2026-07-10 local dry-run's deliberate tag-swap rehearsal (PR #226), now that the 2026-07-19 first production deploy provides a real target to roll back from. **Standing caveat while the GitHub Actions billing lock persists:** GHCR holds no tags for on-box-built images, so "pull the previous tag" becomes "the previous tag is already in the box's local Docker image cache" (`docker image ls`) — the `IMAGE_TAG` swap in `/opt/fleetco/.env` plus `up -d` works unchanged; only a cache-evicted tag would require rebuilding the prior SHA on the box from the repo clone at `/opt/fleetco/src`.
