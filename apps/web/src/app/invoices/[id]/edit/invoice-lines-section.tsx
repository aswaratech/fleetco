"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { CreateLineFormSchema } from "@/lib/invoices-schema";
import { formatNpr, paisaToRupeesInput } from "@/lib/money";

import { addLineAction, removeLineAction, updateLineAction } from "../../actions";
import type { InvoiceLine } from "../../types";

// The DRAFT line workbench (D6 / ADR-0039 c2). A client island that lists the
// invoice's lines with per-row inline edit + remove, plus an add-line form. Each
// mutation calls its server action and, on success, router.refresh() re-renders
// the edit page (the server recomputes the tax preview from the new lines). The
// API derives lineAmountPaisa server-side (quantity * unitPricePaisa) and gates
// every write to a DRAFT (409 otherwise), so this island only collects + converts
// the rupees inputs (anti-pattern #14: paisa stay integers; rupees only at the edge).

interface LineDraft {
  description: string;
  quantity: string;
  unitPrice: string;
}

const EMPTY_DRAFT: LineDraft = { description: "", quantity: "1", unitPrice: "" };

function validate(draft: LineDraft): string | null {
  const parsed = CreateLineFormSchema.safeParse(draft);
  if (parsed.success) return null;
  return parsed.error.issues[0]?.message ?? "Check the line fields.";
}

interface InvoiceLinesSectionProps {
  invoiceId: string;
  lines: InvoiceLine[];
}

const INPUT_NUM = "w-full text-right tabular-nums";

export function InvoiceLinesSection({
  invoiceId,
  lines,
}: InvoiceLinesSectionProps): React.ReactElement {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState<LineDraft>(EMPTY_DRAFT);
  const [addDraft, setAddDraft] = useState<LineDraft>(EMPTY_DRAFT);

  function beginEdit(line: InvoiceLine): void {
    setError(null);
    setEditingId(line.id);
    setEditDraft({
      description: line.description,
      quantity: String(line.quantity),
      unitPrice: paisaToRupeesInput(line.unitPricePaisa),
    });
  }

  function saveEdit(lineId: string): void {
    const message = validate(editDraft);
    if (message) {
      setError(message);
      return;
    }
    setError(null);
    startTransition(async () => {
      const result = await updateLineAction(invoiceId, lineId, editDraft);
      if (result.ok === false) {
        setError(result.message);
        return;
      }
      setEditingId(null);
      router.refresh();
    });
  }

  function removeLine(lineId: string): void {
    setError(null);
    startTransition(async () => {
      const result = await removeLineAction(invoiceId, lineId);
      if (result.ok === false) {
        setError(result.message);
        return;
      }
      router.refresh();
    });
  }

  function addLine(): void {
    const message = validate(addDraft);
    if (message) {
      setError(message);
      return;
    }
    setError(null);
    startTransition(async () => {
      const result = await addLineAction(invoiceId, addDraft);
      if (result.ok === false) {
        setError(result.message);
        return;
      }
      setAddDraft(EMPTY_DRAFT);
      router.refresh();
    });
  }

  return (
    <div className="space-y-4">
      {/* Header row */}
      <div className="text-text-muted grid grid-cols-[1fr_5rem_8rem_8rem_5.5rem] gap-3 px-1 text-xs font-medium tracking-wide uppercase">
        <span>Description</span>
        <span className="text-right">Qty</span>
        <span className="text-right">Unit price</span>
        <span className="text-right">Amount</span>
        <span className="text-right">Actions</span>
      </div>

      {lines.length === 0 ? (
        <p className="text-text-secondary px-1 text-sm">
          No lines yet. Add a manual line below, or build lines from a job’s trips.
        </p>
      ) : (
        <ul className="divide-border-subtle divide-y">
          {lines.map((line) =>
            editingId === line.id ? (
              <li
                key={line.id}
                className="grid grid-cols-[1fr_5rem_8rem_8rem_5.5rem] items-center gap-3 py-2"
              >
                <Input
                  aria-label="Description"
                  value={editDraft.description}
                  onChange={(e) => setEditDraft({ ...editDraft, description: e.target.value })}
                />
                <Input
                  aria-label="Quantity"
                  type="number"
                  min="1"
                  step="1"
                  className={INPUT_NUM}
                  value={editDraft.quantity}
                  onChange={(e) => setEditDraft({ ...editDraft, quantity: e.target.value })}
                />
                <Input
                  aria-label="Unit price"
                  type="number"
                  min="0"
                  step="0.01"
                  className={INPUT_NUM}
                  value={editDraft.unitPrice}
                  onChange={(e) => setEditDraft({ ...editDraft, unitPrice: e.target.value })}
                />
                <span className="text-text-muted text-right text-sm tabular-nums">—</span>
                <span className="flex justify-end gap-1">
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    disabled={isPending}
                    onClick={() => setEditingId(null)}
                  >
                    Cancel
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    disabled={isPending}
                    onClick={() => saveEdit(line.id)}
                  >
                    Save
                  </Button>
                </span>
              </li>
            ) : (
              <li
                key={line.id}
                className="grid grid-cols-[1fr_5rem_8rem_8rem_5.5rem] items-center gap-3 py-2.5"
              >
                <span className="text-text-secondary text-sm">{line.description}</span>
                <span className="text-text-secondary text-right text-sm tabular-nums">
                  {line.quantity}
                </span>
                <span className="text-text-secondary text-right text-sm tabular-nums">
                  {formatNpr(line.unitPricePaisa)}
                </span>
                <span className="text-text-primary text-right text-sm tabular-nums">
                  {formatNpr(line.lineAmountPaisa)}
                </span>
                <span className="flex justify-end gap-1">
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    disabled={isPending}
                    onClick={() => beginEdit(line)}
                  >
                    Edit
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    disabled={isPending}
                    onClick={() => removeLine(line.id)}
                  >
                    Remove
                  </Button>
                </span>
              </li>
            ),
          )}
        </ul>
      )}

      {/* Add a manual line */}
      <div className="border-border-subtle bg-surface-canvas space-y-3 rounded border p-4">
        <h3 className="text-text-secondary text-sm font-medium">Add a line</h3>
        <div className="grid grid-cols-[1fr_5rem_8rem_auto] items-end gap-3">
          <div className="space-y-1">
            <label htmlFor="add-line-description" className="text-text-muted text-xs">
              Description
            </label>
            <Input
              id="add-line-description"
              placeholder="Mobilization fee"
              value={addDraft.description}
              onChange={(e) => setAddDraft({ ...addDraft, description: e.target.value })}
            />
          </div>
          <div className="space-y-1">
            <label htmlFor="add-line-quantity" className="text-text-muted text-xs">
              Qty
            </label>
            <Input
              id="add-line-quantity"
              type="number"
              min="1"
              step="1"
              className={INPUT_NUM}
              value={addDraft.quantity}
              onChange={(e) => setAddDraft({ ...addDraft, quantity: e.target.value })}
            />
          </div>
          <div className="space-y-1">
            <label htmlFor="add-line-unit-price" className="text-text-muted text-xs">
              Unit price
            </label>
            <Input
              id="add-line-unit-price"
              type="number"
              min="0"
              step="0.01"
              placeholder="0.00"
              className={INPUT_NUM}
              value={addDraft.unitPrice}
              onChange={(e) => setAddDraft({ ...addDraft, unitPrice: e.target.value })}
            />
          </div>
          <Button type="button" disabled={isPending} onClick={addLine}>
            {isPending ? "Working…" : "Add line"}
          </Button>
        </div>
      </div>

      {error ? (
        <p role="alert" className="text-status-error text-sm">
          {error}
        </p>
      ) : null}
    </div>
  );
}
