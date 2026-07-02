"use client";

import { useMemo, useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import Link from "next/link";

import { Button } from "@/components/ui/button";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { NepaliDatePicker } from "@/components/nepali-date-picker";
import {
  EXPENSE_CATEGORIES,
  UpdateExpenseLogFormSchema,
  paisaToRupeesInput,
  type UpdateExpenseLogFormInput,
} from "@/lib/expense-logs-schema";

import { updateExpenseLogAction } from "../../actions";
import { EXPENSE_CATEGORY_LABELS, type ExpenseLogDetail } from "../../types";

interface TripOption {
  id: string;
  vehicleId: string;
  status: string;
  vehicle: { id: string; registrationNumber: string };
}

interface EditExpenseLogFormProps {
  expense: ExpenseLogDetail;
  trips: TripOption[];
}

// Edit-expense-log form (iter 22). Pre-fills every editable field
// from the server-fetched expense log. On submit it computes a diff
// against the initial values and only PATCHes the keys the user
// actually changed — see DESIGN.md §"Inputs and forms" "Diff-against-
// initial-values for PATCH" for the project-wide pattern.
//
// `vehicleId` is intentionally excluded from the editable shape (the
// API's PATCH .strict() rejects it). The vehicle binding is rendered
// as static text above the editable fields so the operator can see
// what it is without being able to change it — the operator's mental
// model is that an expense log records a fact about which vehicle
// the cost is attributed to, and rewriting that fact would silently
// rewrite the per-vehicle cost report's basis. A mis-attributed
// expense should be deleted + re-created against the right vehicle.
//
// `tripId` IS editable — the operator may pair a previously-
// unattributed expense with a trip after the trip is created, or
// unpair an expense if the receipt belongs to a different journey.
// The trip picker is only rendered when the expense already has a
// vehicleId — pairing a vehicle-agnostic expense with a trip is
// degenerate (a trip's vehicle would then be the expense's vehicle
// by association). In that branch we render explanatory static text
// instead of the picker.
//
// `amountPaisa` is AUTHORITATIVE — no derivation, no preview row.
// The form has a single `amount` decimal field (NPR rupees); the
// action layer converts to integer paisa via rupeesToPaisa.
export function EditExpenseLogForm({
  expense,
  trips,
}: EditExpenseLogFormProps): React.ReactElement {
  const [submitError, setSubmitError] = useState<string | null>(null);

  // The initial values are derived from the persisted row. Amount
  // (paisa → "R.RR") is converted back into a decimal string for the
  // `<input type="number">`. The ISO date is sliced down to
  // YYYY-MM-DD for `<input type="date">`.
  const initialValues: UpdateExpenseLogFormInput = useMemo(
    () => ({
      tripId: expense.tripId ?? "",
      date: expense.date.slice(0, 10),
      category: expense.category,
      amount: paisaToRupeesInput(expense.amountPaisa),
      vendor: expense.vendor ?? "",
      receiptNumber: expense.receiptNumber ?? "",
      notes: expense.notes ?? "",
    }),
    [expense],
  );

  const form = useForm<UpdateExpenseLogFormInput>({
    resolver: zodResolver(UpdateExpenseLogFormSchema),
    defaultValues: initialValues,
  });

  // Display label for the immutable vehicle binding. Mirrors how the
  // detail page renders the same field.
  const vehicleLabel = expense.vehicle ? expense.vehicle.registrationNumber : "— (no vehicle)";

  async function onSubmit(values: UpdateExpenseLogFormInput): Promise<void> {
    setSubmitError(null);
    form.clearErrors();

    // Compute the diff against the initial values. Only keys whose
    // value strictly differs are included. String comparison works
    // for the dates (YYYY-MM-DD), the decimal strings, the cuid
    // (tripId), the category enum, and the free-form text.
    const changed: Partial<UpdateExpenseLogFormInput> = {};
    (Object.keys(values) as (keyof UpdateExpenseLogFormInput)[]).forEach((key) => {
      if (values[key] !== initialValues[key]) {
        assignChanged(changed, key, values[key]);
      }
    });

    if (Object.keys(changed).length === 0) {
      setSubmitError("Nothing to update.");
      return;
    }

    const result = await updateExpenseLogAction(expense.id, changed);
    if (result && result.ok === false) {
      if (result.field === "tripId") {
        form.setError("tripId", { type: "server", message: result.message });
        return;
      }
      setSubmitError(result.message);
    }
    // On success, updateExpenseLogAction throws NEXT_REDIRECT and
    // the framework navigates us back to /expense-logs/<id>.
  }

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
        {/* Read-only identity row — vehicleId is immutable. Rendered
            with the same visual shape as the editable rows so the
            operator's eye sees the form as one shape. */}
        <div className="space-y-2">
          <span className="text-sm font-medium leading-none">Vehicle</span>
          <Input value={vehicleLabel} disabled readOnly className="font-mono" />
          <p className="text-text-muted text-xs">
            Vehicle binding is fixed. To change it, delete this expense and recreate it.
          </p>
        </div>

        {expense.vehicleId ? (
          <FormField
            control={form.control}
            name="tripId"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Trip (optional)</FormLabel>
                <FormControl>
                  <select
                    className="border-border-strong focus-visible:border-border-focus focus-visible:ring-border-focus/50 aria-invalid:border-status-error aria-invalid:ring-status-error/20 h-9 w-full rounded-md border bg-transparent px-3 py-1 text-sm shadow-xs outline-none transition-[color,box-shadow] focus-visible:ring-[length:var(--focus-ring-width)]"
                    {...field}
                  >
                    <option value="">— no trip —</option>
                    {trips.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.id.slice(0, 8)}… · {t.status}
                      </option>
                    ))}
                  </select>
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
        ) : (
          <div className="space-y-2">
            <span className="text-sm font-medium leading-none">Trip</span>
            <p className="text-text-muted text-xs">
              Trip pairing requires a vehicle binding. This expense has no vehicle, so it cannot be
              paired with a trip.
            </p>
          </div>
        )}

        <FormField
          control={form.control}
          name="date"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Date</FormLabel>
              <FormControl>
                <NepaliDatePicker
                  value={field.value || null}
                  onChange={(iso) => field.onChange(iso ?? "")}
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        <div className="grid gap-4 sm:grid-cols-2">
          <FormField
            control={form.control}
            name="category"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Category</FormLabel>
                <FormControl>
                  <select
                    className="border-border-strong focus-visible:border-border-focus focus-visible:ring-border-focus/50 aria-invalid:border-status-error aria-invalid:ring-status-error/20 h-9 w-full rounded-md border bg-transparent px-3 py-1 text-sm shadow-xs outline-none transition-[color,box-shadow] focus-visible:ring-[length:var(--focus-ring-width)]"
                    {...field}
                  >
                    {EXPENSE_CATEGORIES.map((c) => (
                      <option key={c} value={c}>
                        {EXPENSE_CATEGORY_LABELS[c]}
                      </option>
                    ))}
                  </select>
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="amount"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Amount (NPR)</FormLabel>
                <FormControl>
                  <Input
                    type="number"
                    step="0.01"
                    min="0.01"
                    inputMode="decimal"
                    className="font-mono tabular-nums"
                    {...field}
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <FormField
            control={form.control}
            name="vendor"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Vendor (optional)</FormLabel>
                <FormControl>
                  <Input {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="receiptNumber"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Receipt number (optional)</FormLabel>
                <FormControl>
                  <Input className="font-mono" {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
        </div>

        <FormField
          control={form.control}
          name="notes"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Notes (optional)</FormLabel>
              <FormControl>
                <textarea
                  rows={3}
                  className="border-border-strong focus-visible:border-border-focus focus-visible:ring-border-focus/50 aria-invalid:border-status-error aria-invalid:ring-status-error/20 w-full rounded-md border bg-transparent px-3 py-2 text-sm shadow-xs outline-none transition-[color,box-shadow] focus-visible:ring-[length:var(--focus-ring-width)]"
                  {...field}
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        {submitError ? (
          <p role="alert" className="text-status-error text-sm">
            {submitError}
          </p>
        ) : null}

        <div className="flex items-center justify-end gap-2 pt-2">
          <Button asChild variant="ghost" type="button">
            <Link href={`/expense-logs/${expense.id}`}>Cancel</Link>
          </Button>
          <Button type="submit" disabled={form.formState.isSubmitting}>
            {form.formState.isSubmitting ? "Saving…" : "Save changes"}
          </Button>
        </div>
      </form>
    </Form>
  );
}

// Type-narrow helper for the diff assignment. UpdateExpenseLogFormInput
// is a struct of (mostly) string fields at the input layer; indexed
// assignment otherwise widens to never. Mirror of the matching helper
// in the Fuel logs / Jobs edit forms.
function assignChanged<K extends keyof UpdateExpenseLogFormInput>(
  target: Partial<UpdateExpenseLogFormInput>,
  key: K,
  value: UpdateExpenseLogFormInput[K],
): void {
  target[key] = value;
}
