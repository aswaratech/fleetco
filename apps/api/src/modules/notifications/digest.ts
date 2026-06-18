import { formatNepaliDate } from "@fleetco/shared";

import { type ReminderItem, type ReminderState } from "./compliance-source";

// The pure reminder-digest renderer (ADR-0038 commitment 7). Turns the newly-due
// reminder items into one email body — `{ subject, text, html }` — with dates in
// Bikram Sambat (the SHARED `formatNepaliDate`, so the digest reads the calendar
// the operator thinks in and never drifts from the web's date rendering), in the
// DESIGN.md §Voice register: precise nouns ("Bluebook", not "Document"), state
// the fact, NO exclamation marks, no apology. A mandatory plain-text body; the
// HTML body is a faithful render of the same content. Pure (no I/O, no clock) so
// it is unit-tested in isolation like every FleetCo formatter.
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

// Section ordering + headers, most-urgent first. State the fact (§Voice): the
// header names the state, the line names the cause.
const STATE_SECTIONS: readonly { state: ReminderState; header: string; verb: string }[] = [
  { state: "expired", header: "Expired", verb: "expired" },
  { state: "expiring-soon", header: "Expiring soon", verb: "expires" },
];

// Minimal HTML escaping for the dynamic values (registration numbers are
// operator-entered). Defense-in-depth — these values are low-risk, but a digest
// body should never interpolate untrusted text into HTML unescaped.
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

/**
 * Render the newly-due reminder items into a digest email. Items are grouped by
 * state (expired first, then expiring soon), each line stating the vehicle, the
 * document, and the Bikram-Sambat expiry date. Caller guarantees `items` is
 * non-empty (an empty digest is never sent — ADR-0038 c4).
 */
export function renderComplianceDigest(items: readonly ReminderItem[]): RenderedDigest {
  const subject = `FleetCo — ${summaryLine(items.length)}`;

  const textBlocks: string[] = [`${summaryLine(items.length)}.`];
  const htmlBlocks: string[] = [`<p>${escapeHtml(summaryLine(items.length))}.</p>`];

  for (const section of STATE_SECTIONS) {
    const sectionItems = items.filter((item) => item.state === section.state);
    if (sectionItems.length === 0) continue;

    const textLines = sectionItems.map(
      (item) =>
        `- ${item.subjectLabel} — ${item.kindLabel} (${section.verb} ${formatNepaliDate(
          item.occurrenceKey,
        )})`,
    );
    textBlocks.push(`${section.header}\n${textLines.join("\n")}`);

    const htmlItems = sectionItems.map(
      (item) =>
        `<li>${escapeHtml(item.subjectLabel)} — ${escapeHtml(item.kindLabel)} (${
          section.verb
        } ${escapeHtml(formatNepaliDate(item.occurrenceKey))})</li>`,
    );
    htmlBlocks.push(`<h2>${escapeHtml(section.header)}</h2>\n<ul>\n${htmlItems.join("\n")}\n</ul>`);
  }

  return {
    subject,
    text: textBlocks.join("\n\n") + "\n",
    html: htmlBlocks.join("\n"),
  };
}
