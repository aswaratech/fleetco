"use client";

import { useMemo, useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import Link from "next/link";

import { Button } from "@/components/ui/button";
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { NepaliDatePicker } from "@/components/nepali-date-picker";
import { formatNepaliDate } from "@/lib/nepali-date";
import { formatNpr } from "@/lib/money";
import {
  CreateServiceRecordFormSchema,
  type CreateServiceRecordFormValues,
  type UpdateServiceRecordFormValues,
} from "@/lib/service-records-schema";
import { tenthsToHoursInput } from "@/lib/units";

import { updateServiceRecordAction } from "../../actions";
import type { ServiceRecord } from "../../types";
import { EXPENSE_CATEGORY_LABELS, type ExpenseCategory } from "../../../expense-logs/types";

export interface EditRecordScheduleOption {
  id: string;
  name: string;
}

export interface EditRecordExpenseOption {
  id: string;
  amountPaisa: number;
  date: string;
  category: ExpenseCategory;
}

interface EditServiceRecordFormProps {
  record: ServiceRecord;
  vehicleRegistration: string;
  // Schedules + MAINTENANCE/REPAIR expenses already scoped to the record's
  // (immutable) vehicle by the page, so no client-side filtering is needed.
  schedules: EditRecordScheduleOption[];
  expenses: EditRecordExpenseOption[];
}

// Edit-service-record form (ADR-0037 B5). Pre-fills from the server-fetched
// record; vehicleId is immutable (shown read-only, never in the diff). The
// schedule + cost-link pickers are scoped to the record's vehicle by the page.
// On submit it diffs against the initial values and PATCHes only the changed
// keys; a cleared link ("") becomes wire null. The full CreateServiceRecordForm
// Schema is the resolver (vehicleId is set to the record's vehicle so it
// validates) — the action re-validates the diff and the API stays authoritative.
export function EditServiceRecordForm({
  record,
  vehicleRegistration,
  schedules,
  expenses,
}: EditServiceRecordFormProps): React.ReactElement {
  const [submitError, setSubmitError] = useState<string | null>(null);

  const initialValues: CreateServiceRecordFormValues = useMemo(
    () => ({
      vehicleId: record.vehicleId,
      serviceScheduleId: record.serviceScheduleId ?? "",
      expenseLogId: record.expenseLogId ?? "",
      performedAt: record.performedAt.slice(0, 10),
      odometerKm: record.odometerKm === null ? "" : String(record.odometerKm),
      engineHours: record.engineHours === null ? "" : tenthsToHoursInput(record.engineHours),
      notes: record.notes ?? "",
    }),
    [record],
  );

  const form = useForm<CreateServiceRecordFormValues>({
    resolver: zodResolver(CreateServiceRecordFormSchema),
    defaultValues: initialValues,
  });

  async function onSubmit(values: CreateServiceRecordFormValues): Promise<void> {
    setSubmitError(null);
    form.clearErrors();

    const editableKeys: (keyof UpdateServiceRecordFormValues)[] = [
      "serviceScheduleId",
      "expenseLogId",
      "performedAt",
      "odometerKm",
      "engineHours",
      "notes",
    ];
    const changed: Partial<UpdateServiceRecordFormValues> = {};
    for (const key of editableKeys) {
      if (values[key] !== initialValues[key]) {
        assignChanged(changed, key, values[key]);
      }
    }

    if (Object.keys(changed).length === 0) {
      setSubmitError("Nothing to update.");
      return;
    }

    const result = await updateServiceRecordAction(record.id, changed);
    if (result && result.ok === false) {
      if (result.field === "expenseLogId") {
        form.setError("expenseLogId", { type: "server", message: result.message });
        return;
      }
      if (result.field === "serviceScheduleId") {
        form.setError("serviceScheduleId", { type: "server", message: result.message });
        return;
      }
      setSubmitError(result.message);
    }
    // On success the action throws NEXT_REDIRECT back to the detail page.
  }

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
        {/* vehicleId is immutable post-create — shown read-only. */}
        <div className="space-y-1">
          <p className="text-text-muted text-xs font-medium tracking-wide uppercase">Vehicle</p>
          <p className="text-text-primary font-mono text-sm">{vehicleRegistration}</p>
          <p className="text-text-muted text-xs">
            The vehicle cannot be changed. Delete and recreate the record to move it.
          </p>
        </div>

        <FormField
          control={form.control}
          name="serviceScheduleId"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Schedule (optional)</FormLabel>
              <FormControl>
                <select
                  className="border-input focus-visible:border-ring focus-visible:ring-ring/50 aria-invalid:border-destructive aria-invalid:ring-destructive/20 h-9 w-full rounded-md border bg-transparent px-3 py-1 text-sm shadow-xs outline-none transition-[color,box-shadow] focus-visible:ring-[3px]"
                  {...field}
                >
                  <option value="">— ad-hoc (no schedule) —</option>
                  {schedules.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
              </FormControl>
              <FormDescription>
                Re-linking does not re-advance the schedule&apos;s anchor — that happens only when a
                service is first recorded.
              </FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="performedAt"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Performed at</FormLabel>
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
            name="odometerKm"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Odometer reading (km, optional)</FormLabel>
                <FormControl>
                  <Input
                    type="number"
                    inputMode="numeric"
                    step="1"
                    min="0"
                    className="font-mono tabular-nums"
                    {...field}
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="engineHours"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Engine hours (optional)</FormLabel>
                <FormControl>
                  <Input
                    type="number"
                    inputMode="decimal"
                    step="0.1"
                    min="0"
                    className="font-mono tabular-nums"
                    {...field}
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
        </div>

        <FormField
          control={form.control}
          name="expenseLogId"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Cost link (optional)</FormLabel>
              <FormControl>
                <select
                  className="border-input focus-visible:border-ring focus-visible:ring-ring/50 aria-invalid:border-destructive aria-invalid:ring-destructive/20 h-9 w-full rounded-md border bg-transparent px-3 py-1 text-sm shadow-xs outline-none transition-[color,box-shadow] focus-visible:ring-[3px]"
                  {...field}
                >
                  <option value="">— no cost link —</option>
                  {expenses.map((e) => (
                    <option key={e.id} value={e.id}>
                      {formatNpr(e.amountPaisa)} · {formatNepaliDate(e.date, { format: "bs" })} ·{" "}
                      {EXPENSE_CATEGORY_LABELS[e.category]}
                    </option>
                  ))}
                </select>
              </FormControl>
              <FormDescription>
                The expense-log row that holds this service&apos;s cost — read through the link,
                never a second money column.
              </FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="notes"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Notes (optional)</FormLabel>
              <FormControl>
                <textarea
                  rows={3}
                  className="border-input focus-visible:border-ring focus-visible:ring-ring/50 aria-invalid:border-destructive aria-invalid:ring-destructive/20 w-full rounded-md border bg-transparent px-3 py-2 text-sm shadow-xs outline-none transition-[color,box-shadow] focus-visible:ring-[3px]"
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
            <Link href={`/service-records/${record.id}`}>Cancel</Link>
          </Button>
          <Button type="submit" disabled={form.formState.isSubmitting}>
            {form.formState.isSubmitting ? "Saving…" : "Save changes"}
          </Button>
        </div>
      </form>
    </Form>
  );
}

// Type-narrow helper for the diff assignment (mirror of the other edit forms).
function assignChanged<K extends keyof UpdateServiceRecordFormValues>(
  target: Partial<UpdateServiceRecordFormValues>,
  key: K,
  value: UpdateServiceRecordFormValues[K],
): void {
  target[key] = value;
}
