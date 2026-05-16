# Security Incident Response

> **STATUS: ACTIVE.** This procedure is the founder's reference for handling security incidents in FleetCo. It is a peer of the general incident response procedure and references the security baseline in ADR-0012 and the data classification in ADR-0013.

A security incident is any event that compromises or threatens to compromise the confidentiality, integrity, or availability of FleetCo's data, credentials, or infrastructure. Examples include a credential leak (a Tier 1 secret accidentally committed to the repository or shared in a chat log), a vulnerability disclosure from a researcher or from automated scanning, a known-vulnerable dependency that the security baseline has flagged, an unauthorized access attempt detected in the logs, or a customer report of suspicious activity.

Security incidents are treated with the same severity discipline as operational incidents (per ADR-0011) but with additional steps for credential rotation, evidence preservation, and external communication.

## Step one: contain

The first action in a security incident is containment. If a credential has leaked, rotate it immediately, before anything else, even before assessing the full scope. The cost of an unnecessary rotation is small; the cost of a leaked credential remaining valid while you investigate is potentially total.

Specifically, for a credential leak: revoke the leaked credential at its source (rotate the API key, change the database password, regenerate the OAuth secret), update the production secret store with the new credential, redeploy the affected services to pick up the new credential, and verify that the leaked credential no longer works by attempting to use it.

For a vulnerability that has not yet been exploited: assess whether the affected component can be safely disabled or rolled back. If it can, do so. If it cannot, proceed to remediation directly.

For an unauthorized access attempt: if the attempt was successful, treat it as a credential leak and follow the credential leak procedure. If the attempt was unsuccessful but persistent, consider rate-limiting or blocking the source.

## Step two: assess scope

Once containment is in place, assess the scope of the incident. For a credential leak, the assessment includes determining when the credential was exposed, who could have accessed the exposure (was it in a public repository, a private one, a chat log with a known set of participants), and what data the credential could have been used to access. The scope determines the customer communication.

For a vulnerability, the assessment includes determining whether the vulnerability has been exploited (looking for indicators of compromise in logs and database state), what data could be affected if it has been exploited, and what the timeline of exposure is.

Document the scope in the running incident notes. This becomes part of the postmortem and, where relevant, part of the customer communication.

## Step three: communicate

Communication for security incidents is more cautious than for operational incidents. The customer is informed if there is any plausible risk that their data has been affected, but the communication is factual and does not speculate about scope until the assessment is complete. The communication acknowledges the incident, states what is known and what is not, and commits to an update timeline.

If the incident involved exposure of personal data, regulatory considerations may apply. Nepal's Individual Privacy Act 2018 and any other relevant regulation determines what notifications are required. When in doubt, consult a lawyer or compliance professional before sending notifications, because incorrect notifications can be worse than no notifications. The retainer for the technical substitute identified in the business continuity plan should ideally include a referral pathway to a security and compliance professional for these situations.

## Step four: remediate

Remediate the underlying issue. For a credential leak, this is the rotation already performed in step one plus the addition of a CI rule or process change that prevents the same kind of leak from recurring (for example, a pre-commit hook that scans for credential patterns, or a process change that ensures the founder never pastes credentials into chat logs). For a vulnerability, this is the patch or version bump that addresses it. For an unauthorized access attempt, this is whatever access control change reduces the risk of recurrence.

Remediation should be the smallest change that addresses the immediate issue. Comprehensive security improvements happen after the immediate incident is resolved, often as part of the postmortem follow-up.

## Step five: postmortem

All security incidents, regardless of severity, produce a postmortem. This is a stricter rule than the general incident procedure (which exempts SEV3 from postmortem) because security incidents are exactly the kind that recur if not learned from. The postmortem follows the format in `docs/postmortems/README.md` and is committed to the postmortems folder, but with a security-specific section that covers what data was affected, what regulatory or contractual obligations were triggered, and what changes were made to the security baseline as a result.

The postmortem may identify changes to the security baseline (ADR-0012) or the data classification (ADR-0013). If so, those ADRs are updated through the normal ADR amendment process.

## Last verified

**Last verified:** 2026-05-16 — first authored version of this procedure. The procedure has been read and committed but has not yet been exercised against a real security incident; that operational verification happens when the first real security signal arrives (e.g., a Dependabot alert against a Phase 1 dependency, or a Sentry-detected anomaly meeting the security-incident definition). Reviewed at least quarterly per the discipline stated in this document.
