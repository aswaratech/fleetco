import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { NepaliDate } from "@/components/nepali-date";
import { Badge } from "@/components/ui/badge";
import { apiFetch, ApiError } from "@/lib/api";
import {
  reminderKindLabel,
  stateBadgeVariant,
  stateLabel,
  subjectTypeLabel,
} from "@/lib/notification-logs";
import { getServerSession } from "@/lib/session";

import type { NotificationLog } from "../types";

// NotificationLog detail — the full audit record for one reminder send
// (ADR-0038 C4). Server-rendered shell (auth gate; 404 via notFound()); READ-ONLY
// (no Edit / Delete — the ledger is append-only). Mirrors
// apps/web/src/app/customers/[id]/page.tsx: a definition list under DESIGN.md
// §"Data display" tokens, two-column on >= sm.
//
// It surfaces the fields the list compresses or omits — the precise dedup anchor
// (occurrenceKey) and the exact send instant — which is the audit value: a
// reviewer can confirm exactly which lapse was notified, to whom, and when.

interface DetailPageProps {
  params: Promise<{ id: string }>;
}

// Precise UTC instant (the "… UTC" audit-timestamp convention, DESIGN.md §"BS
// calendar": date-only fields render BS; precise instants render UTC). Mirror of
// the customers detail page formatter.
function formatTimestamp(iso: string | null): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toISOString().replace("T", " ").slice(0, 19) + " UTC";
}

export default async function NotificationLogDetailPage({
  params,
}: DetailPageProps): Promise<React.ReactElement> {
  const session = await getServerSession();
  if (!session) {
    redirect("/login");
  }

  const { id } = await params;

  let log: NotificationLog;
  try {
    log = await apiFetch<NotificationLog>(`/api/v1/notification-logs/${id}`);
  } catch (error) {
    if (error instanceof ApiError) {
      if (error.status === 401) {
        redirect("/login");
      }
      if (error.status === 404) {
        notFound();
      }
    }
    throw error;
  }

  return (
    <main className="bg-surface-canvas min-h-svh">
      <div className="mx-auto max-w-3xl space-y-6 px-8 py-8">
        <header className="space-y-1">
          <nav aria-label="Breadcrumb" className="text-text-muted text-sm">
            <Link href="/" className="hover:text-text-primary">
              FleetCo
            </Link>
            <span aria-hidden="true"> › </span>
            <Link href="/notification-logs" className="hover:text-text-primary">
              Reminder history
            </Link>
            <span aria-hidden="true"> › </span>
            <span className="text-text-secondary">
              {subjectTypeLabel(log.subjectType)} · {reminderKindLabel(log.reminderKind)}
            </span>
          </nav>
          <h1 className="text-text-primary flex items-center gap-3 text-2xl font-semibold">
            {subjectTypeLabel(log.subjectType)} · {reminderKindLabel(log.reminderKind)}
            <Badge variant={stateBadgeVariant(log.state)}>{stateLabel(log.state)}</Badge>
          </h1>
          <p className="text-text-muted text-sm">
            Sent <NepaliDate iso={log.sentAt} format="both" />
          </p>
        </header>

        <section className="border-border-subtle bg-surface-raised rounded border p-6 shadow-sm">
          <dl className="grid grid-cols-1 gap-x-8 gap-y-4 sm:grid-cols-2">
            <DetailRow label="Reminder type" value={subjectTypeLabel(log.subjectType)} />
            <DetailRow label="Kind" value={reminderKindLabel(log.reminderKind)} />
            <DetailRow
              label="State"
              value={<Badge variant={stateBadgeVariant(log.state)}>{stateLabel(log.state)}</Badge>}
            />
            <DetailRow label="Subject id" value={log.subjectId} mono />
            {/* The due anchor (occurrenceKey) is the dedup occurrence — an expiry
                ISO date for compliance, a meter value or date for a service
                schedule — so it is rendered as raw text, never date-coerced
                (a meter value is not a date). */}
            <DetailRow label="Due anchor" value={log.occurrenceKey} mono />
            <DetailRow label="Recipient" value={log.recipient} mono />
            <DetailRow
              label="Sent"
              value={log.sentAt ? <NepaliDate iso={log.sentAt} format="both" /> : "—"}
            />
            <DetailRow label="Sent at (UTC)" value={formatTimestamp(log.sentAt)} />
            <DetailRow
              label="Provider message id"
              value={log.providerMessageId ?? "—"}
              mono={Boolean(log.providerMessageId)}
            />
            <DetailRow label="Recorded at" value={formatTimestamp(log.createdAt)} />
          </dl>
        </section>
      </div>
    </main>
  );
}

interface DetailRowProps {
  label: string;
  value: React.ReactNode;
  mono?: boolean;
}

function DetailRow({ label, value, mono }: DetailRowProps): React.ReactElement {
  const valueClass = ["text-text-primary text-sm", mono ? "font-mono break-all" : ""]
    .filter(Boolean)
    .join(" ");
  return (
    <div className="space-y-1">
      <dt className="text-text-muted text-xs font-medium uppercase tracking-wide">{label}</dt>
      <dd className={valueClass}>{value}</dd>
    </div>
  );
}
