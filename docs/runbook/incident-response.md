# Incident Response Procedure

> **STATUS: ACTIVE.** This procedure is the founder's reference for handling production incidents in FleetCo. The procedure references the severity classification in ADR-0011 and the postmortem discipline in `docs/postmortems/README.md`.

This document is the procedural memory for what to do when something goes wrong in production. It is written for a single-operator context (the founder) and assumes no on-call rotation, no incident commander, and no paging system beyond Sentry alerts. The procedure is deliberately simple because a complex procedure is one that does not get followed under stress.

## When this procedure applies

This procedure applies whenever you become aware of a production issue that affects FleetCo's operation, whether through a Sentry alert, a customer report, a self-detected anomaly, or any other channel. The procedure does not distinguish by source; what matters is the severity, which is determined per ADR-0011.

## Step one: classify the incident

Determine the severity within five minutes of becoming aware of the incident. The classification is per ADR-0011: SEV1 if customer-facing core operations (trip creation, fuel logging, the central business workflows) are unavailable or producing wrong data; SEV2 if non-core modules are degraded or a core module is degraded but functional; SEV3 if the issue is non-customer-impacting (logging gap, backup verification failure, minor UI defect).

When in doubt about severity, classify higher. It is much cheaper to respond to a SEV2 as if it were a SEV1 and discover it was less serious than thought, than to under-classify a real SEV1 and discover the customer impact too late.

Record the initial classification in a temporary working note. The classification may change as more information becomes available; that is normal and the running record will reflect the changes.

## Step two: communicate

For SEV1, inform the customer immediately, before beginning technical investigation. The communication is a short message acknowledging the issue, naming what is currently affected, and committing to an update in a specific time window (typically 30 minutes). The customer needs to know they are not in the dark; technical investigation can begin in parallel.

For SEV2, inform the customer within the first hour of detection. The communication is similar in form to SEV1 but with a longer update window (typically 2 hours).

For SEV3, communication is not required during the incident itself but the issue is logged and may be communicated as part of the next routine update.

The communication channel is whatever has been established with the customer (email, WhatsApp, phone). The contact information lives in the business continuity plan.

## Step three: investigate

Begin the technical investigation by checking the obvious sources first. Sentry for recent error spikes. The application logs for the last hour. Recent deploys (if a deploy happened in the last 24 hours, it is the prime suspect). The database for connection issues, slow queries, or replication lag. The job queue for stuck jobs or backed-up work. External service status pages (Cloudflare, the email provider, etc.) for upstream issues.

Do not go straight to code changes. Investigation comes before remediation. The exception is when the issue is clearly attributable to a recent deploy and rolling back is the obvious response; in that case, roll back first and investigate the root cause after service is restored.

Keep a running notes file of what you check and what you find. This becomes the timeline portion of the postmortem if the incident is SEV1 or SEV2.

## Step four: remediate

For incidents caused by a recent deploy, the remediation is to roll back to the previous known-good version. The procedure for rollback lives in `docs/runbook/rollback.md`.

For incidents caused by external dependencies, the remediation may be to wait, to switch to a fallback if one exists, or to communicate to users that a known external issue is affecting service.

For incidents caused by data issues, capacity issues, or configuration issues, the remediation is specific to the issue and is figured out during investigation. The remediation should be the smallest change that restores service; comprehensive fixes happen after the immediate incident is resolved.

For incidents that you cannot resolve within the time window appropriate to the severity, escalate to the technical substitute identified in the business continuity plan. SEV1 incidents that are not resolved within 4 hours should engage the substitute; SEV2 incidents that are not resolved within 8 hours should engage the substitute. The substitute is the person to whom you have already paid a retainer and whose involvement is part of the plan, not someone you are reaching out to cold.

## Step five: confirm resolution

Verify that service is restored by exercising the affected functionality directly. For a SEV1 affecting trip creation, the verification is to create a trip end-to-end and confirm it succeeds. For a SEV2 affecting reports, the verification is to run the affected reports and confirm correct output. The verification is not "the error stopped appearing in Sentry"; that is necessary but not sufficient.

Communicate the resolution to the customer. The communication acknowledges the incident, confirms service is restored, and indicates when a postmortem will be available (within seven days for SEV1 and SEV2).

## Step six: postmortem

For SEV1 and SEV2 incidents, write a postmortem within seven days of the incident's resolution. The postmortem follows the format in `docs/postmortems/README.md` and is committed to the postmortems folder. The postmortem is blameless: it focuses on what happened, what we learned, and what we are changing, not on who made what mistake.

For SEV3 incidents, a postmortem is not required but a tech-debt entry is added if a follow-up fix is needed.

If the incident consumed more than 20 percent of the error budget for either SLI in the rolling 28-day window, the postmortem must commit to specific reliability improvements before the next feature ships. This is the error-budget policy from ADR-0011 in operational form.

## Last verified

**Last verified:** 2026-05-16 — first authored version of this procedure. The procedure has been read and committed but has not yet been exercised against a real incident; that operational verification happens when Phase 1 ships its first production deploy and the first real signal arrives. Reviewed at least quarterly per the discipline stated in this document, and immediately after every SEV1 or SEV2 incident.
