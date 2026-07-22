"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { NepaliDatePicker } from "@/components/nepali-date-picker";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { formatNpr } from "@/lib/money";
import { RENEWAL_KIND_LABELS, type RenewalKind } from "@/lib/renewals";

import { recordRenewalAction, type RecordRenewalInput } from "./actions";

interface DocumentOption {
  id: string;
  title: string;
}

interface ExpenseOption {
  id: string;
  amountPaisa: number;
  date: string;
  notes: string | null;
}

interface RenewalFormProps {
  vehicleId: string;
  kind: RenewalKind;
  /** Current vehicle values, pre-filling the kind's identity fields. */
  current: {
    bluebookNumber: string | null;
    insurer: string | null;
    insurancePolicyNumber: string | null;
    insuranceType: string | null;
    routePermitNumber: string | null;
  };
  /** The vehicle's documents of the kind's matching category. */
  documents: DocumentOption[];
  /** Same-vehicle expense logs in the kind's allowed categories, newest first. */
  expenses: ExpenseOption[];
}

const INSURANCE_TYPES = [
  { value: "THIRD_PARTY", label: "Third party" },
  { value: "COMPREHENSIVE", label: "Comprehensive" },
] as const;

function todayIso(): string {
  return new Date().toISOString();
}

// The renew form (ADR-0049 F5, DESIGN.md §"Fleet documents & renewals"):
// kind pre-selected (read-only — the three Renew buttons are the entry
// points), the new expiry via NepaliDatePicker, the kind's identity fields
// pre-filled from current values (editing them updates the vehicle in the
// same atomic action; leaving them keeps what stands), optional proof-
// document and cost-expense selects (link, never re-enter), and notes.
export function RenewalForm({
  vehicleId,
  kind,
  current,
  documents,
  expenses,
}: RenewalFormProps): React.ReactElement {
  const router = useRouter();
  const [newExpiresAt, setNewExpiresAt] = useState<string | null>(null);
  const [renewedAt, setRenewedAt] = useState<string | null>(todayIso());
  const [bluebookNumber, setBluebookNumber] = useState(current.bluebookNumber ?? "");
  const [insurer, setInsurer] = useState(current.insurer ?? "");
  const [policyNumber, setPolicyNumber] = useState(current.insurancePolicyNumber ?? "");
  const [insuranceType, setInsuranceType] = useState(current.insuranceType ?? "");
  const [permitNumber, setPermitNumber] = useState(current.routePermitNumber ?? "");
  const [documentId, setDocumentId] = useState("");
  const [expenseLogId, setExpenseLogId] = useState("");
  const [notes, setNotes] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function handleSubmit(event: React.FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    setError(null);
    if (newExpiresAt === null) {
      setError("New expiry date is required.");
      return;
    }

    const input: RecordRenewalInput = { kind, newExpiresAt };
    if (renewedAt !== null) input.renewedAt = renewedAt;
    if (kind === "BLUEBOOK" && bluebookNumber.trim().length > 0) {
      input.bluebookNumber = bluebookNumber.trim();
    }
    if (kind === "INSURANCE") {
      if (insurer.trim().length > 0) input.insurer = insurer.trim();
      if (policyNumber.trim().length > 0) input.insurancePolicyNumber = policyNumber.trim();
      if (insuranceType.length > 0) input.insuranceType = insuranceType;
    }
    if (kind === "ROUTE_PERMIT" && permitNumber.trim().length > 0) {
      input.routePermitNumber = permitNumber.trim();
    }
    if (documentId.length > 0) input.documentId = documentId;
    if (expenseLogId.length > 0) input.expenseLogId = expenseLogId;
    if (notes.trim().length > 0) input.notes = notes.trim();

    startTransition(async () => {
      const result = await recordRenewalAction(vehicleId, input);
      if (result.ok) {
        router.push(`/vehicles/${vehicleId}`);
        return;
      }
      setError(result.message);
    });
  }

  const selectClasses =
    "border-border-subtle bg-surface-canvas h-9 w-full rounded border px-3 text-sm";

  return (
    <form onSubmit={handleSubmit} className="max-w-xl space-y-6">
      <div className="space-y-1">
        <span className="text-sm font-medium">Item</span>
        <p className="text-text-secondary text-sm">{RENEWAL_KIND_LABELS[kind]}</p>
      </div>

      <div className="space-y-2">
        <span className="text-sm font-medium">New expiry</span>
        <NepaliDatePicker value={newExpiresAt} onChange={(iso) => setNewExpiresAt(iso)} />
      </div>

      <div className="space-y-2">
        <span className="text-sm font-medium">Renewed on</span>
        <NepaliDatePicker value={renewedAt} onChange={(iso) => setRenewedAt(iso)} />
      </div>

      {kind === "BLUEBOOK" ? (
        <div className="space-y-2">
          <label htmlFor="renewal-bluebook-number" className="text-sm font-medium">
            Bluebook number
          </label>
          <Input
            id="renewal-bluebook-number"
            value={bluebookNumber}
            onChange={(event) => setBluebookNumber(event.target.value)}
            maxLength={64}
          />
        </div>
      ) : null}

      {kind === "INSURANCE" ? (
        <>
          <div className="space-y-2">
            <label htmlFor="renewal-insurer" className="text-sm font-medium">
              Insurer
            </label>
            <Input
              id="renewal-insurer"
              value={insurer}
              onChange={(event) => setInsurer(event.target.value)}
              maxLength={128}
            />
          </div>
          <div className="space-y-2">
            <label htmlFor="renewal-policy-number" className="text-sm font-medium">
              Policy number
            </label>
            <Input
              id="renewal-policy-number"
              value={policyNumber}
              onChange={(event) => setPolicyNumber(event.target.value)}
              maxLength={64}
            />
          </div>
          <div className="space-y-2">
            <label htmlFor="renewal-insurance-type" className="text-sm font-medium">
              Insurance type
            </label>
            <select
              id="renewal-insurance-type"
              value={insuranceType}
              onChange={(event) => setInsuranceType(event.target.value)}
              className={selectClasses}
            >
              <option value="">— keep current —</option>
              {INSURANCE_TYPES.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>
        </>
      ) : null}

      {kind === "ROUTE_PERMIT" ? (
        <div className="space-y-2">
          <label htmlFor="renewal-permit-number" className="text-sm font-medium">
            Route permit number
          </label>
          <Input
            id="renewal-permit-number"
            value={permitNumber}
            onChange={(event) => setPermitNumber(event.target.value)}
            maxLength={64}
          />
        </div>
      ) : null}

      <div className="space-y-2">
        <label htmlFor="renewal-document" className="text-sm font-medium">
          Document <span className="text-text-muted font-normal">(optional)</span>
        </label>
        <select
          id="renewal-document"
          value={documentId}
          onChange={(event) => setDocumentId(event.target.value)}
          className={selectClasses}
          disabled={documents.length === 0}
        >
          <option value="">— none —</option>
          {documents.map((document) => (
            <option key={document.id} value={document.id}>
              {document.title}
            </option>
          ))}
        </select>
        <p className="text-text-muted text-xs">
          {documents.length === 0
            ? `No ${RENEWAL_KIND_LABELS[kind].toLowerCase()} documents on this vehicle yet — upload the new paper first, then renew.`
            : "Link the new paper as this renewal's proof."}
        </p>
      </div>

      <div className="space-y-2">
        <label htmlFor="renewal-expense" className="text-sm font-medium">
          Cost <span className="text-text-muted font-normal">(optional)</span>
        </label>
        <select
          id="renewal-expense"
          value={expenseLogId}
          onChange={(event) => setExpenseLogId(event.target.value)}
          className={selectClasses}
          disabled={expenses.length === 0}
        >
          <option value="">— none —</option>
          {expenses.map((expense) => (
            <option key={expense.id} value={expense.id}>
              {formatNpr(expense.amountPaisa)}
              {expense.notes ? ` — ${expense.notes.slice(0, 60)}` : ""}
            </option>
          ))}
        </select>
        <p className="text-text-muted text-xs">
          Record the fee as an expense log first — the renewal links it, never re-enters it.
        </p>
      </div>

      <div className="space-y-2">
        <label htmlFor="renewal-notes" className="text-sm font-medium">
          Notes <span className="text-text-muted font-normal">(optional)</span>
        </label>
        <Input
          id="renewal-notes"
          value={notes}
          onChange={(event) => setNotes(event.target.value)}
          maxLength={2048}
        />
      </div>

      {error === null ? null : <p className="text-status-error text-sm">{error}</p>}

      <div className="flex gap-3">
        <Button type="submit" disabled={isPending}>
          {isPending ? "Recording…" : "Record renewal"}
        </Button>
        <Button
          type="button"
          variant="outline"
          onClick={() => router.push(`/vehicles/${vehicleId}`)}
        >
          Cancel
        </Button>
      </div>
    </form>
  );
}
