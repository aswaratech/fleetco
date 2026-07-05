# ADR-0013: Data classification and privacy posture

- **Status:** Accepted
- **Date:** 2026-05-09
- **Decider:** Product owner (CEO)

## Context

FleetCo holds data of varying sensitivity from the moment Phase 1 ships, and the sensitivity grows substantially in subsequent phases. In Phase 1 the system holds driver names and license numbers, vehicle registration data, customer commercial terms, fuel and expense records, and the founder's own administrative credentials. In Phase 2 the system adds GPS traces of vehicles, which are personally identifying data of a particularly sensitive kind because a GPS trace reveals the work patterns of the company and the location patterns of the driver. In Phase 3 the system adds compliance documents (Bluebook scans, insurance certificates, route permits), which contain identifying information that can be used in identity-related fraud. In Phase 4 the system adds financial records that interact with Nepal's Inland Revenue Department.

A modern delivery operating model articulates a data classification scheme, a retention policy, an encryption posture, and a documented Recovery Point Objective and Recovery Time Objective. None of these is currently in the bootstrap. For a system serving a single Nepal-based heavy-construction customer, the regulatory environment is less prescriptive than GDPR or India's Digital Personal Data Protection Act, but Nepal does have data protection requirements through its Individual Privacy Act 2018 and other regulations, and any reasonable customer will eventually ask for a data-handling commitment. The cost of writing this ADR before Phase 1 ships is modest; the cost of writing it after the first data-related incident is substantially higher.

## Decision

We commit to a four-tier data classification scheme. Tier 1 is administrative and authentication data: founder credentials, API keys, signing secrets. This data never appears in source code, never appears in logs (even at debug level), and is stored only in the production secret store. Tier 2 is personally identifying information of drivers and customers: names, license numbers, contact information, identification document numbers. This data is encrypted at rest in the database, is not logged by default, and access is restricted to authenticated administrative users. Tier 3 is operational business data: vehicle records, trip records, fuel logs, expense records, jobs, customer commercial terms. This data is encrypted at rest, is logged at the level of operational events but not at the level of full record content, and access follows the role-based access control rules to be defined in Phase 2. Tier 4 is non-sensitive metadata: system logs at info level, performance metrics, aggregated reports without individual identification. This data may be logged in full and may be retained without the specific retention controls that apply to higher tiers.

The retention policy commits to retaining Tier 2 and Tier 3 data for as long as the operational business need exists, which for a fleet ERP is the lifetime of the customer relationship plus a reasonable archival period (initially set at three years after the end of the customer relationship, subject to revision based on Nepali regulatory guidance). When data is deleted, the deletion is recorded in an audit log so that "we deleted that record on date X" is a fact the system can produce. Backups retain data for 30 days, after which the encrypted backups are pruned automatically.

The encryption posture commits to encryption at rest for the database (Postgres native encryption or filesystem-level encryption on the VPS), encryption in transit for all API traffic (TLS 1.2 or higher with modern cipher suites), and encryption at rest for object storage (Cloudflare R2 default encryption, which uses AES-256). Secrets are stored in the production environment using either the deployment platform's native secret management or a dedicated secret store such as HashiCorp Vault or AWS Secrets Manager (the specific choice is to be made in the deployment ADR not yet written).

The Recovery Point Objective for Tier 1, Tier 2, and Tier 3 data is 24 hours, meaning that the maximum acceptable data loss in a disaster is one day's worth of data. The Recovery Time Objective is 4 hours for the API and admin web (the operational substrate must be back within 4 hours of a disaster), and 24 hours for the driver app (acceptable to be down for a working day in Phase 2). These targets are consistent with the daily-backup discipline already committed to and with the modest infrastructure profile of a single-VPS deployment. They will tighten in Phase 2 as the system matures.

The privacy posture commits to the principle of data minimization: we collect only the data we have a clear operational need for, we do not collect data "just in case," and when we add a new data field we explicitly justify why it is needed. We commit to honoring data subject requests (a driver who asks for their data to be deleted, a customer who asks for an export of their records) within 30 days of the request. The procedure for handling such requests lives in the runbook.

## Alternatives considered

Adopting a more elaborate classification scheme (such as a five-tier model with separate categories for financial data and health data) was considered and rejected as premature for a fleet ERP. Four tiers cover the data sensitivity we currently see, and the scheme can be expanded if a future module introduces a kind of data the existing tiers do not address.

Adopting GDPR-equivalent commitments (right to data portability, data protection officer, full DPIA process) was considered and partially adopted. The principles of data minimization, encryption, retention limits, and data subject rights are adopted because they are good practice regardless of jurisdiction. The procedural overhead (formal DPO, formal DPIA) is not adopted because it is not yet justified by either the regulatory environment or the customer base.

Skipping the data classification until a customer asks for it was considered and rejected. Data classification work is much harder to do retroactively because the existing data has accumulated without the classification in mind, and applying classification rules after the fact often requires reprocessing or rebuilding parts of the schema. The cost of classifying data before it exists is small; the cost of classifying it after is large.

## Consequences

The schema work in Phase 1 must take the data classification into account. Fields that are Tier 2 (driver names, license numbers) need to be marked in the Prisma schema with comments indicating their tier, so that future contributors and the AI agent know not to log or expose them casually. The logging configuration must be set up so that Tier 2 and Tier 3 data is not captured by default. The PR template must include a question about whether the change introduces new data and what tier it falls into.

The runbook acquires entries on data-subject-request handling, on backup verification (which is already there in stub form but now has explicit RPO/RTO targets), and on credential rotation (which is part of Tier 1 hygiene).

The cost of this ADR is the cost of taking data classification seriously from the start, which slows down new schema work by a small amount and forces explicit discussion of every new data field. The benefit is that we are positioned to honor customer or regulatory requests without panic, and we have a defensible data-handling story for any contractual conversation.

## Revisit when

The signal to revisit this decision is a regulatory change in Nepal that materially affects the obligations of a data controller, a customer requirement that exceeds the current commitments, or the addition of a data category that the current four tiers do not cover. The Phase 2 introduction of GPS traces is a candidate for revisiting because GPS traces have privacy properties that may justify a fifth tier or a tighter retention policy.

---

**Annotation (2026-07-02, append-only):** ADR-0043 amends this ADR for a new egress class: fleet data flowing to a **hosted third-party LLM API** (DeepSeek-first) inside the AI chat agent's prompts. The amendment (in ADR-0043 §ADR-0013 amendment) names the flow, classifies agent chat transcripts Tier 2, and fixes the redaction contract — Tier-5 GPS coordinates, `licenseNumber`, and `dateOfBirth` never enter prompts; ordinary operational data (names, phones as operational contact data) may. This is the second amendment to this ADR; the first was ADR-0027 (Tier 5, GPS/telematics).

**Annotation (2026-07-05, append-only):** Two further changes. **ADR-0044** (third amendment) governs uploaded document images (receipts, vendor bills, identity documents): they are **processed locally on FleetCo infrastructure and never egress as pixels** (its Box B resolved to a self-hosted OCR sidecar); attachment bytes are Tier-2-handled with 180-day transcript retention, and what reaches the hosted LLM is the extraction's content inside the normal turn — Tier-2 transcript data of the same class as typed dictation, with the c6 tool-result redaction contract unchanged. **ADR-0045** resolves the financial-records revisit this ADR's §Revisit-when anticipated: no fifth tier — financial records stay Tier 3 with named handling rules (a provisional six-fiscal-year statutory retention floor, capture-aids-are-not-books-of-account, access-logging deferred with a named trigger).
