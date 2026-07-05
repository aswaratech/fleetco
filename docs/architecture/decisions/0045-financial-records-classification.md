# ADR-0045: Financial-records data classification — the owed ADR-0013 revisit

- **Status:** Accepted (ratified by the PO merging PR #208 on 2026-07-05, alongside ADR-0044; flipped from Proposed in this follow-up docs commit)
- **Date:** 2026-07-05
- **Decider:** Product owner (CEO)

## Context

ADR-0013 committed to a four-tier classification and deliberately rejected a separate financial tier as premature, noting Phase 4 would force the question. Phase 4's invoicing shipped early (ADR-0039, Program D), and the question was parked as an explicit tech-debt entry: *"whether invoices warrant a distinct data-classification tier … longer retention … and/or mandatory audit-logging — flagged here, to be DECIDED in its own ADR, NOT assumed now."* This is that ADR.

It is being decided now because ADR-0044 makes the question concrete in a new way: photographed **vendor bills** will flow through agent transcripts (Tier 2, 180-day prune) and R2, and their extracted contents will become structured financial rows. Deciding the classification *after* financial documents start flowing through an LLM pipeline would be the retroactive-classification failure mode ADR-0013 itself warned about.

What exists today: `Invoice`/`InvoiceLine`/credit-note documents (issued invoices immutable, never deleted; DRAFT→ISSUED→CANCELLED lifecycle), expense and fuel logs with optional `receiptNumber` strings, buyer PAN already handled Tier 3, invoice PDFs frozen to R2 on issue. The sole user is the CEO; there are no finance-role users, no external auditor access, and no production deployment yet.

## Decision

**Financial records stay Tier 3 — no fifth tier — with three named handling rules that sit on top of the tier.** The sensitivity of financial data in a single-tenant, owner-operated ERP differs from operational data in *retention* and *attribution*, not in *who may read it*; handling rules express that precisely where a new tier would blur it.

1. **Retention floor (the statutory rule).** Structured financial records — invoices, credit notes, and the expense/fuel rows that feed tax-relevant reporting — are retained at least through Nepal's statutory record-keeping period for tax documents. **Provisional floor: six full fiscal years after the fiscal year of issue** — a deliberately conservative reading, to be verified against the Income Tax Act / VAT Act requirements with the company's accountant before the first fiscal-year close in production (named follow-up, tracked in tech-debt). This floor overrides the ADR-0013 default (customer relationship + three years) wherever the default would be shorter. Issued invoices additionally remain immutable and undeletable per ADR-0039 — retention here is about never pruning them early, which no current code does; this rule exists so no future retention job may.

2. **Capture aids are not books of account.** A photographed bill or receipt entering through ADR-0044's attachment pipeline is an *entry aid*: it lives as agent-transcript content (Tier 2 handling, 180-day prune, R2 object deleted with it). The **structured row it produces is the durable financial record** and carries the retention floor above. If the business ever needs source-document archival (audit-grade receipt storage), that is the entity-documents program with entity-lifetime retention — explicitly not this pipeline.

3. **Attribution and lifecycle control.** Financial lifecycle operations — invoice issue, cancel, credit-note — remain human-only (the ADR-0043 exclusion, reaffirmed by ADR-0044) and attributable via `createdById`. Mandatory access-logging (who downloaded/viewed which financial document) is **deferred with a named trigger**: the first external-party access (accountant, auditor) or the first non-ADMIN finance role. Until then the single-user reality makes an access log a record of the CEO reading his own documents.

**Egress posture:** financial-operational content (amounts, vendors, dates, PANs incidentally present on documents) may egress to the LLM providers under the ADR-0043 c6 / ADR-0044 c8 contracts — typed or photographed. No financial-specific masking is added: an agent that cannot see amounts and vendors cannot do financial data entry, and the audience is the ADMIN owner. The working assumption stays best-effort provider retention, as ADR-0043 c6 states.

## Alternatives considered

**A fifth "financial" tier.** Rejected, consistent with ADR-0013's original reasoning: every concrete need surfaced (longer retention, immutability, attribution, eventual access-logging) is a handling rule on Tier 3, not a different access class. A new tier would force re-marking schema comments and redaction lists for zero behavioral change today.

**Blanket no-egress for financial data.** Rejected: it would exclude the vendor-bills class the PO explicitly wants and cripple the agent's reporting over costs. The single-tenant, owner-only audience and the already-accepted c6 posture make the marginal exposure a deliberate, bounded acceptance.

**Indefinite retention of bill/receipt images.** Rejected: it silently converts a chat pipeline into the company's document archive without archive-grade guarantees. The capture-aid framing keeps the durable record structured and the archive decision honest for its own future program.

**Deferring this ADR until the accountant conversation.** Rejected: ADR-0044 needs the classification *before* bills start flowing; the statutory-period verification is the only piece that can safely trail, and it has a conservative floor meanwhile.

## Consequences

The tech-debt entry is discharged into this ADR (the remaining follow-up — accountant verification of the statutory period — is re-recorded there, pointing here). Future retention work must honor the six-fiscal-year floor for financial rows; the ADR-0044 attachment prune is unaffected (capture aids, rule 2). No schema, code, or redaction-list change is required today — this ADR's value is that the *absence* of change is now a decision rather than an omission. The cost accepted: financial document images transit and briefly persist in a Tier-2 pipeline with best-effort provider retention — bounded by the 180-day prune and the enumerated-classes rule in ADR-0044 c8.

## Revisit when

- The **accountant/statute verification** returns a period different from the provisional six fiscal years → amend rule 1 by annotation with the verified figure.
- **External access arrives** (accountant, auditor, IRD request) or a **finance role** beyond ADMIN exists → the deferred access-logging trigger fires; implement it then.
- A **customer contract or Nepali regulatory change** imposes financial-data handling beyond these rules.
- The **entity-documents program** is opened → source-document archival gets its own retention decision there; rule 2's boundary is re-examined.

## Relationship to prior ADRs

- **ADR-0013** — third… fourth amendment context: this ADR resolves the revisit ADR-0013's §Revisit-when anticipated and the tech-debt entry demanded; ADR-0013 carries a dated annotation pointing here (its amendment chain: ADR-0027, ADR-0043, ADR-0044, this).
- **ADR-0039** — invoice immutability and the R2 PDF freeze are inputs; nothing here weakens them.
- **ADR-0044** — companion: its vendor-bills document class is conditional on this ADR; its capture-aid pipeline is bounded by rule 2.
- **ADR-0043** — the c6 egress contract extends to financial content unchanged.
