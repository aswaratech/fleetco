# Business Continuity Plan

> **STATUS: STUB — illustrative content.** This document is the founder's commitment to a degraded-mode operation plan and an unavailability handoff. The framework is complete and the shape of the filled-in content is demonstrated below with synthetic placeholder values clearly marked `[ILLUSTRATIVE]`. Every illustrative value must be replaced with real values by the founder before this procedure becomes operational; the real-content swap is tracked in `docs/tech-debt.md`. The `Last review` date at the foot is real (today's date of first authored version).

A business continuity plan exists for a specific reason: a single-founder, single-customer software business has the same kind of operational fragility that a small medical practice or a one-attorney law firm has. The technical infrastructure is reasonably resilient (Postgres backups, R2 redundancy, CI gates, SLO discipline) but the human substrate is not redundant at all. If the founder is unavailable for two weeks, whether through illness, family emergency, or any other reason, the customer needs to be able to continue operating and the system needs to continue running without the founder making any decisions.

This document is the procedural memory for that scenario. It is written so that the customer or a designated substitute can execute it without needing to ask the founder anything, because by hypothesis the founder is unavailable. It is also written so that the founder, when returning from unavailability, can pick up where things left off without confusion about what happened in the meantime.

## What "unavailability" means

The plan distinguishes between three lengths of unavailability. Short unavailability is up to three working days, such as an unexpected illness or a planned short vacation without internet access. The plan for short unavailability is to inform the customer in advance when possible, monitor incoming alerts via mobile if any reach a SEV1 threshold, and otherwise let routine operations continue without intervention. The system is designed to operate without daily founder attention, so short unavailability should not require any specific action.

Medium unavailability is from four working days to two weeks, such as a longer vacation, a family emergency, or a serious illness with expected recovery. The plan for medium unavailability requires explicit handoff to the customer's designated point of contact, suspension of all non-critical changes (no deploys other than security patches), and preparation of a substitute who can handle SEV1 incidents if they arise during the period.

Extended unavailability is more than two weeks, including indefinite unavailability. The plan for extended unavailability is the most thorough and requires designating a substitute developer or developer team who has the access, the documentation, and the agreement to maintain the system on behalf of the customer until the founder returns or until a more permanent arrangement is made.

## Designated points of contact

The customer has a designated business point of contact who is the person the founder communicates with about scheduling, billing, and operational changes. This person's contact information lives below and is updated whenever the customer organization changes the relationship.

The founder has a designated personal point of contact who is the person who should be informed if the founder is unavailable due to circumstances the founder cannot communicate themselves. This person has access to the basic information needed to inform the customer that an extended unavailability is beginning. This person is typically a family member or close friend rather than a technical person, and their role is communication rather than operational substitution.

The founder has a designated technical substitute who is a developer or developer team capable of handling FleetCo's operational needs in the founder's absence. This is the most consequential designation because it is the person who can actually keep the system running. The substitute is identified by name and contractual relationship, has signed agreements regarding access and confidentiality, and has been given access to the credentials and documentation needed to operate the system.

The three designated points of contact are listed below. **All values in this section are `[ILLUSTRATIVE]` placeholders pending real-content swap by the founder; see the active entry in `docs/tech-debt.md`.** When real values are in hand, the placeholders are replaced, the STATUS line is updated, and the tech-debt entry is moved to the paid-off section.

**Business POC** — the customer-side person the founder communicates with about scheduling, billing, and operational changes.

- Name and role: `[ILLUSTRATIVE]` Rabi Sharma, Director of Operations, Acme Construction Pvt. Ltd.
- Primary contact: `[ILLUSTRATIVE]` +977-98xx-xxxxxx (WhatsApp preferred)
- Backup contact: `[ILLUSTRATIVE]` rabi.sharma@example.com
- Last contact: `[ILLUSTRATIVE]` 2026-04-22

**Personal POC** — the family member or close friend informed if the founder is unavailable due to circumstances the founder cannot communicate themselves.

- Name and relationship: `[ILLUSTRATIVE]` Anita Pandey, sister
- Primary contact: `[ILLUSTRATIVE]` +977-98xx-xxxxxx (mobile)
- Information held: `[ILLUSTRATIVE]` Knows the location of the sealed physical envelope (see below); holds an activated-but-pending 1Password emergency-access invite

**Technical substitute** — the developer or developer team capable of handling FleetCo's operational needs in the founder's absence.

- Name and contractual relationship: `[ILLUSTRATIVE]` Bikash Thapa, independent contractor (sole proprietor under "Thapa Software Services")
- Retainer terms: `[ILLUSTRATIVE]` NPR 15,000/month base; on-call up to 8 hours/month included; additional hours billed at NPR 3,000/hour
- Signed agreements: `[ILLUSTRATIVE]` NDA and master services agreement, both signed 2026-01-15; signed copies held by founder
- Access protocol: `[ILLUSTRATIVE]` On activation by the personal POC, Bikash receives credentials via 1Password emergency-access (pre-staged, see below); production SSH key already shared in encrypted form, decryption passphrase lives in the sealed envelope
- Primary contact: `[ILLUSTRATIVE]` +977-98xx-xxxxxx (phone, 9am–9pm NPT); bikash@example.com

## Credentials and access

The credentials needed to operate FleetCo include the production server SSH access, the database superuser credentials, the Cloudflare R2 access keys, the `age` backup-decryption identity (the private key that decrypts the nightly offsite `pg_dump` backups — without it the backups are unrecoverable; see `docs/runbook/restore-from-backup.md`), the GitHub repository administrative access (including the GHCR pull token the production box uses for `docker login ghcr.io`), the domain registrar account, the email and notification provider credentials, and the payment processing credentials (when Phase 4 introduces them). Each of these is a Tier 1 secret per ADR-0013 and is stored in the production secret store, which itself has access controlled by the founder.

For business continuity purposes, the founder maintains a sealed envelope (physical or in a secure password manager with emergency access enabled) that contains the master credentials needed to bootstrap recovery. The envelope is held by the personal point of contact identified above. The envelope is updated whenever the master credentials change.

**All values in this section are `[ILLUSTRATIVE]` placeholders pending real-content swap by the founder; see the active entry in `docs/tech-debt.md`.**

- Format: `[ILLUSTRATIVE]` 1Password (hosted), using its built-in emergency-access feature, with a sealed physical envelope as a fallback if the 1Password feature itself is unavailable.
- Held by / configured in: `[ILLUSTRATIVE]` Founder's personal 1Password account. Emergency-access invites are pre-configured for the personal POC (Anita) and the technical substitute (Bikash); both invites are held by the recipients in pending state. The fallback envelope is a tamper-evident physical envelope held by the personal POC at her home in a fireproof box.
- Activation procedure: `[ILLUSTRATIVE]` Either the personal POC or the technical substitute initiates "request emergency access" in 1Password. The founder has a 72-hour deny window — if the founder does not deny the request within 72 hours, access auto-grants. The founder may temporarily lower this window in advance (e.g., to 24 hours) when traveling or otherwise expecting reduced ability to respond. If the 1Password emergency-access feature is itself unavailable (account locked, service outage), the personal POC opens the fallback envelope, which contains the master 1Password account password and a one-page recovery procedure.
- Credentials accessible via emergency access: `[ILLUSTRATIVE]` Production secret-store master credentials; database superuser credentials; the `age` backup-decryption identity; Cloudflare R2 access keys; GitHub repository admin token (and the GHCR pull token); domain registrar account; email and notification provider credentials.
- Credentials NOT accessible via emergency access: `[ILLUSTRATIVE]` Payment processing credentials (introduced in Phase 4) — these require a separate handoff process documented at that time, because regulatory and contractual constraints around financial credentials demand a more controlled access path than the general operational-credentials envelope.
- Update cadence: `[ILLUSTRATIVE]` Quarterly review; immediately whenever any master credential rotates; immediately whenever the personal POC or technical substitute changes.

## Degraded mode operation

In an extreme scenario where the founder is unavailable and the technical substitute cannot be reached, the customer needs to be able to continue operating in a degraded mode that does not require any technical intervention. The system is designed so that the existing data remains accessible read-only through the admin UI for at least 30 days without any administrative attention, because the database backups are scheduled and the application server runs unattended. The customer cannot create new records during this period, but they can see the records that exist, which is sufficient to continue billing customers and paying drivers based on the most recent state of the system.

If the period of unavailability extends beyond 30 days, the customer should engage a different developer or developer team to take over operations. The handoff documentation lives in the runbook and includes the architecture overview, the deployment procedures, the credential locations, and the contact information for the technical substitute.

## What the founder commits to

The founder commits to the following operational disciplines that make this plan workable. The credentials are kept current in the secret store and the emergency envelope. The technical substitute is identified, paid a retainer, and engaged at least quarterly to verify that they can still execute the plan. The customer is informed about the existence of this plan and given the contact information they need to reach the substitute. The plan itself is reviewed at least annually and updated when the operational substrate changes.

These commitments are not ceremonial. They are the difference between a one-person business that survives a serious unavailability and one that loses its customer relationship during the founder's absence. The cost of the commitments is moderate (a quarterly engagement with a substitute, an annual plan review) and the benefit is substantial (a customer who is not exposed to single-point-of-failure risk).

## Last review

**Last review:** 2026-05-16 — first authored version of this plan. The framework and the shape of all required fields are committed today; the `[ILLUSTRATIVE]`-marked values throughout will be replaced with real values by the founder before Phase 1 ships, per the active entry in `docs/tech-debt.md`.
