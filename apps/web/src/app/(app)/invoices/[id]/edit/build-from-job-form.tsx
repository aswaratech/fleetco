"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { BuildFromJobFormSchema } from "@/lib/invoices-schema";

import { buildFromJobAction } from "../../actions";

// Build-from-job (D6 / ADR-0039 c2, c8). The operator picks a job (for provenance)
// and a set of TRIPS to bill, keying a quantity + unit price per trip. This is NOT
// a Job→Trip traversal: the schema has NO Trip→Job link (see docs/tech-debt.md
// "Trip is not linked to Job"), so the operator selects the trips; the API verifies
// the job belongs to the invoice's customer and stamps each line's description with
// the trip's date in Bikram Sambat. On success router.refresh() re-renders the edit
// page (the lines list + the tax preview update).
//
// A client island with local state (a job + an array of trip-line drafts); the
// batch is validated against BuildFromJobFormSchema before the action runs. Rupees
// convert to integer paisa in the action (anti-pattern #14).

export interface JobOption {
  id: string;
  jobNumber: string;
  description: string;
}

export interface TripOption {
  id: string;
  label: string;
}

interface TripLineDraft {
  tripId: string;
  quantity: string;
  unitPrice: string;
}

const EMPTY_ROW: TripLineDraft = { tripId: "", quantity: "1", unitPrice: "" };

interface BuildFromJobFormProps {
  invoiceId: string;
  jobs: JobOption[];
  trips: TripOption[];
}

const SELECT_CLASS =
  "border-input focus-visible:border-ring focus-visible:ring-ring/50 h-9 w-full rounded-md border bg-transparent px-3 py-1 text-sm shadow-xs outline-none transition-[color,box-shadow] focus-visible:ring-[3px]";
const INPUT_NUM = "w-full text-right tabular-nums";

export function BuildFromJobForm({
  invoiceId,
  jobs,
  trips,
}: BuildFromJobFormProps): React.ReactElement {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const [jobId, setJobId] = useState<string>(jobs[0]?.id ?? "");
  const [rows, setRows] = useState<TripLineDraft[]>([{ ...EMPTY_ROW }]);

  function updateRow(index: number, patch: Partial<TripLineDraft>): void {
    setRows((prev) => prev.map((r, i) => (i === index ? { ...r, ...patch } : r)));
  }

  function addRow(): void {
    setRows((prev) => [...prev, { ...EMPTY_ROW }]);
  }

  function removeRow(index: number): void {
    setRows((prev) => (prev.length === 1 ? prev : prev.filter((_, i) => i !== index)));
  }

  function build(): void {
    const candidate = { jobId, lines: rows };
    const parsed = BuildFromJobFormSchema.safeParse(candidate);
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? "Check the job and trip lines.");
      return;
    }
    setError(null);
    startTransition(async () => {
      const result = await buildFromJobAction(invoiceId, parsed.data);
      if (result.ok === false) {
        setError(result.message);
        return;
      }
      setRows([{ ...EMPTY_ROW }]);
      router.refresh();
    });
  }

  if (jobs.length === 0) {
    return (
      <p className="text-text-secondary text-sm">
        This customer has no jobs on file, so there is nothing to build from. Add manual lines
        above, or book a job for this customer first.
      </p>
    );
  }

  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <label htmlFor="build-job" className="text-text-muted text-xs font-medium">
          Job
        </label>
        <select
          id="build-job"
          className={SELECT_CLASS}
          value={jobId}
          onChange={(e) => setJobId(e.target.value)}
        >
          {jobs.map((j) => (
            <option key={j.id} value={j.id}>
              {j.jobNumber} — {j.description.slice(0, 60)}
            </option>
          ))}
        </select>
        <p className="text-text-muted text-xs">
          The job must belong to this invoice’s customer. It tags each built line for provenance.
        </p>
      </div>

      <div className="space-y-2">
        <div className="text-text-muted grid grid-cols-[1fr_5rem_8rem_2.5rem] gap-3 px-1 text-xs font-medium tracking-wide uppercase">
          <span>Trip</span>
          <span className="text-right">Qty</span>
          <span className="text-right">Unit price</span>
          <span />
        </div>
        {rows.map((row, index) => (
          <div key={index} className="grid grid-cols-[1fr_5rem_8rem_2.5rem] items-center gap-3">
            <select
              aria-label="Trip"
              className={SELECT_CLASS}
              value={row.tripId}
              onChange={(e) => updateRow(index, { tripId: e.target.value })}
            >
              <option value="">— pick a trip —</option>
              {trips.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.label}
                </option>
              ))}
            </select>
            <Input
              aria-label="Quantity"
              type="number"
              min="1"
              step="1"
              className={INPUT_NUM}
              value={row.quantity}
              onChange={(e) => updateRow(index, { quantity: e.target.value })}
            />
            <Input
              aria-label="Unit price"
              type="number"
              min="0"
              step="0.01"
              placeholder="0.00"
              className={INPUT_NUM}
              value={row.unitPrice}
              onChange={(e) => updateRow(index, { unitPrice: e.target.value })}
            />
            <Button
              type="button"
              variant="ghost"
              size="sm"
              aria-label="Remove trip line"
              disabled={isPending || rows.length === 1}
              onClick={() => removeRow(index)}
            >
              ✕
            </Button>
          </div>
        ))}
      </div>

      {trips.length === 0 ? (
        <p className="text-text-muted text-xs">
          No trips on file to bill. Record trips first, then build from them here.
        </p>
      ) : null}

      <div className="flex items-center gap-2">
        <Button type="button" variant="outline" size="sm" disabled={isPending} onClick={addRow}>
          Add trip line
        </Button>
        <Button type="button" disabled={isPending} onClick={build}>
          {isPending ? "Building…" : "Build lines"}
        </Button>
      </div>

      {error ? (
        <p role="alert" className="text-status-error text-sm">
          {error}
        </p>
      ) : null}
    </div>
  );
}
