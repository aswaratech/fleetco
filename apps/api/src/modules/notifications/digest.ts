import { formatNepaliDate } from "@fleetco/shared";

import { SUBJECT_TYPE_VEHICLE, type ReminderItem, type ReminderState } from "./compliance-source";
import { SUBJECT_TYPE_SERVICE_SCHEDULE } from "./maintenance-source";

// The pure reminder-digest renderer (ADR-0038 commitment 7). Turns the newly-due
// reminder items into one email body — `{ subject, text, html }` — with dates in
// Bikram Sambat (the SHARED `formatNepaliDate`, so the digest reads the calendar
// the operator thinks in and never drifts from the web's date rendering), in the
// DESIGN.md §Voice register: precise nouns ("Bluebook", a schedule's own name),
// state the fact, NO exclamation marks, no apology. A mandatory plain-text body;
// the HTML body is a faithful render of the same content. Pure (no I/O, no clock)
// so it is unit-tested in isolation like every FleetCo formatter.
//
// C3 BATCHES BOTH KINDS, GROUPED. The digest now renders two domains — Compliance
// (vehicle documents, ADR-0031) and Maintenance (service schedules, ADR-0037) —
// each as its own block with its own state sub-sections (most urgent first). An
// item's domain is its `subjectType`; its "due" detail is `dueLabel` when the
// source pre-rendered one (maintenance, whose occurrenceKey is a meter value or a
// date), else `formatNepaliDate(occurrenceKey)` (compliance, whose occurrenceKey
// IS the expiry date). A domain with no items is omitted entirely; a digest with
// only compliance items renders exactly as it did in C2.
//
// The `to` recipient is NOT part of the rendered digest — the scan addresses one
// send per recipient (ADR-0038 c4), so the renderer produces the shared content
// and the send wraps it with `to`.

/** The rendered digest content (a {@link MailMessage} without its `to`). */
export interface RenderedDigest {
  subject: string;
  text: string;
  html: string;
}

// One state sub-section within a domain: the header names the state, the verb
// names the cause (§Voice: state the fact). Ordered most-urgent first.
interface StateSection {
  state: ReminderState;
  header: string;
  verb: string;
}

// One domain (a reminder kind family): its block header and its ordered state
// sub-sections. Items are routed to a domain by `subjectType`.
interface DomainConfig {
  subjectType: string;
  header: string;
  sections: readonly StateSection[];
}

// Compliance (ADR-0031): expired before expiring-soon, the C2 ordering + verbs.
const COMPLIANCE_DOMAIN: DomainConfig = {
  subjectType: SUBJECT_TYPE_VEHICLE,
  header: "Compliance",
  sections: [
    { state: "expired", header: "Expired", verb: "expired" },
    { state: "expiring-soon", header: "Expiring soon", verb: "expires" },
  ],
};

// Maintenance (ADR-0037 / C3): overdue before due-soon, the service words.
const MAINTENANCE_DOMAIN: DomainConfig = {
  subjectType: SUBJECT_TYPE_SERVICE_SCHEDULE,
  header: "Maintenance",
  sections: [
    { state: "overdue", header: "Overdue", verb: "overdue" },
    { state: "due-soon", header: "Due soon", verb: "due" },
  ],
};

// Compliance first (legal lapses outrank maintenance), then maintenance.
const DOMAINS: readonly DomainConfig[] = [COMPLIANCE_DOMAIN, MAINTENANCE_DOMAIN];

// Minimal HTML escaping for the dynamic values (registration numbers and
// schedule names are operator-entered). Defense-in-depth — these values are
// low-risk, but a digest body should never interpolate untrusted text into HTML
// unescaped.
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// "1 item needs attention" / "3 items need attention" — the subject summary
// count. Subject-verb agreement on the singular. No exclamation (§Voice #2).
function summaryLine(count: number): string {
  return count === 1 ? "1 item needs attention" : `${count} items need attention`;
}

// The "due" detail for one item: the source's pre-rendered `dueLabel` (the
// maintenance meter value / BS date) when present, else the compliance expiry
// rendered in Bikram Sambat from its ISO occurrenceKey. Compliance items have no
// dueLabel, so this preserves the C2 output byte-for-byte.
function dueDetail(item: ReminderItem): string {
  return item.dueLabel ?? formatNepaliDate(item.occurrenceKey);
}

/**
 * Render the newly-due reminder items into a digest email. Items are grouped by
 * domain (Compliance, then Maintenance), and within each domain by state (most
 * urgent first); each line states the subject, the kind, and the
 * Bikram-Sambat / meter "due" detail. Caller guarantees `items` is non-empty (an
 * empty digest is never sent — ADR-0038 c4).
 */
export function renderReminderDigest(items: readonly ReminderItem[]): RenderedDigest {
  const subject = `FleetCo — ${summaryLine(items.length)}`;

  const textBlocks: string[] = [`${summaryLine(items.length)}.`];
  const htmlBlocks: string[] = [`<p>${escapeHtml(summaryLine(items.length))}.</p>`];

  for (const domain of DOMAINS) {
    const domainItems = items.filter((item) => item.subjectType === domain.subjectType);
    if (domainItems.length === 0) continue;

    const textSections: string[] = [];
    const htmlSections: string[] = [`<h2>${escapeHtml(domain.header)}</h2>`];

    for (const section of domain.sections) {
      const sectionItems = domainItems.filter((item) => item.state === section.state);
      if (sectionItems.length === 0) continue;

      const textLines = sectionItems.map(
        (item) => `- ${item.subjectLabel} — ${item.kindLabel} (${section.verb} ${dueDetail(item)})`,
      );
      textSections.push(`${section.header}\n${textLines.join("\n")}`);

      const htmlItems = sectionItems.map(
        (item) =>
          `<li>${escapeHtml(item.subjectLabel)} — ${escapeHtml(item.kindLabel)} (${
            section.verb
          } ${escapeHtml(dueDetail(item))})</li>`,
      );
      htmlSections.push(
        `<h3>${escapeHtml(section.header)}</h3>\n<ul>\n${htmlItems.join("\n")}\n</ul>`,
      );
    }

    // Domain header line, then its state sub-sections (text); the HTML domain
    // header + sub-sections were assembled above.
    textBlocks.push(`${domain.header}\n${textSections.join("\n\n")}`);
    htmlBlocks.push(htmlSections.join("\n"));
  }

  return {
    subject,
    text: textBlocks.join("\n\n") + "\n",
    html: htmlBlocks.join("\n"),
  };
}
