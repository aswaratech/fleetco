import { NepaliDate } from "@/components/nepali-date";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { apiFetch } from "@/lib/api";
import { formatNpr } from "@/lib/money";
import { RENEWAL_KIND_LABELS, type RenewalsListResponse } from "@/lib/renewals";

// The per-vehicle renewal history (ADR-0049 F5, DESIGN.md §"Fleet documents
// & renewals"): the append-only proof trail the atomic renew writes — old →
// new expiry (both BS), the linked paper (opens through the authed proxy),
// and the linked cost (rendered from the nested summary; the amount lives in
// the ExpenseLog, never re-entered here). Newest first; a server component
// beside the vehicle page.
export async function RenewalHistorySection({
  vehicleId,
}: {
  vehicleId: string;
}): Promise<React.ReactElement> {
  const renewals = await apiFetch<RenewalsListResponse>(
    `/api/v1/vehicles/${encodeURIComponent(vehicleId)}/renewals?take=50`,
  );

  return (
    <section className="border-border-subtle bg-surface-raised rounded border p-6 shadow-sm">
      <h2 className="text-text-muted mb-4 text-xs font-medium uppercase tracking-wide">
        Renewal history
      </h2>
      {renewals.items.length === 0 ? (
        <p className="text-text-muted text-sm">No renewals recorded for this vehicle.</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Renewed</TableHead>
              <TableHead>Item</TableHead>
              <TableHead>Old → new expiry</TableHead>
              <TableHead className="text-right">Cost</TableHead>
              <TableHead>Document</TableHead>
              <TableHead>Notes</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {renewals.items.map((renewal) => (
              <TableRow key={renewal.id}>
                <TableCell>
                  <NepaliDate iso={renewal.renewedAt} format="bs" />
                </TableCell>
                <TableCell>{RENEWAL_KIND_LABELS[renewal.kind]}</TableCell>
                <TableCell>
                  <span className="inline-flex flex-wrap items-center gap-1">
                    {renewal.previousExpiresAt === null ? (
                      <span>—</span>
                    ) : (
                      <NepaliDate iso={renewal.previousExpiresAt} format="bs" />
                    )}
                    <span aria-hidden="true" className="text-text-muted">
                      →
                    </span>
                    <NepaliDate iso={renewal.newExpiresAt} format="bs" />
                  </span>
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {renewal.expenseLog === null ? "—" : formatNpr(renewal.expenseLog.amountPaisa)}
                </TableCell>
                <TableCell>
                  {renewal.document === null ? (
                    "—"
                  ) : (
                    <a
                      href={`/api/documents/${renewal.document.id}`}
                      target="_blank"
                      rel="noreferrer"
                      className="text-text-accent hover:underline"
                    >
                      Open
                    </a>
                  )}
                </TableCell>
                <TableCell className="text-text-muted">{renewal.notes ?? "—"}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </section>
  );
}
