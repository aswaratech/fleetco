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
} from "@/lib/service-records-schema";

import { createServiceRecordAction } from "../actions";
import { EXPENSE_CATEGORY_LABELS, type ExpenseCategory } from "../../expense-logs/types";

export interface RecordVehicleOption {
  id: string;
  registrationNumber: string;
}

export interface RecordScheduleOption {
  id: string;
  name: string;
  vehicleId: string;
}

export interface RecordExpenseOption {
  id: string;
  vehicleId: string | null;
  amountPaisa: number;
  date: string;
  category: ExpenseCategory;
}

interface CreateServiceRecordFormProps {
  vehicles: RecordVehicleOption[];
  schedules: RecordScheduleOption[];
  expenses: RecordExpenseOption[];
  defaultVehicleId: string;
  defaultScheduleId: string;
}

// Create-service-record form (ADR-0037 B5). The shell at ../new/page.tsx
// server-renders the chrome, gates auth, and pre-fetches the pickers' options;
// this component handles input. createServiceRecordAction performs the API call
// and redirects on success.
//
// The schedule and cost-link pickers are filtered CLIENT-SIDE to the chosen
// vehicle (a record's schedule must be on the same vehicle, and its linked
// expense must be a same-vehicle MAINTENANCE/REPAIR row — ADR-0037 c5/c6). When
// the vehicle changes, both pickers reset so a mismatched pair is never carried
// into submit; both are disabled until a vehicle is chosen. Both are optional —
// an unset schedule is an ad-hoc service; an unset cost link is a warranty /
// not-yet-invoiced service.
//
// The cost link reads the amount THROUGH the ExpenseLog (formatNpr over its
// amountPaisa) — there is never a money column on a ServiceRecord (ADR-0037 c6).
export function CreateServiceRecordForm({
  vehicles,
  schedules,
  expenses,
  defaultVehicleId,
  defaultScheduleId,
}: CreateServiceRecordFormProps): React.ReactElement {
  const [submitError, setSubmitError] = useState<string | null>(null);

  const form = useForm<CreateServiceRecordFormValues>({
    resolver: zodResolver(CreateServiceRecordFormSchema),
    defaultValues: {
      vehicleId: defaultVehicleId,
      serviceScheduleId: defaultScheduleId,
      expenseLogId: "",
      // Default to today (UTC) — the common case is recording a service done
      // today. The operator can change it.
      performedAt: new Date().toISOString().slice(0, 10),
      odometerKm: "",
      engineHours: "",
      notes: "",
    },
  });

  const watchedVehicleId = form.watch("vehicleId");
  const pickerDisabled = watchedVehicleId === "";

  const eligibleSchedules = useMemo(
    () =>
      watchedVehicleId === "" ? [] : schedules.filter((s) => s.vehicleId === watchedVehicleId),
    [schedules, watchedVehicleId],
  );

  // Eligible cost-link expenses: same vehicle, MAINTENANCE/REPAIR (the server
  // pre-fetch already restricts category, so this only narrows by vehicle).
  const eligibleExpenses = useMemo(
    () => (watchedVehicleId === "" ? [] : expenses.filter((e) => e.vehicleId === watchedVehicleId)),
    [expenses, watchedVehicleId],
  );

  async function onSubmit(values: CreateServiceRecordFormValues): Promise<void> {
    setSubmitError(null);
    form.clearErrors();
    const result = await createServiceRecordAction(values);
    if (result && result.ok === false) {
      if (result.field === "expenseLogId") {
        form.setError("expenseLogId", { type: "server", message: result.message });
        return;
      }
      if (result.field === "serviceScheduleId") {
        form.setError("serviceScheduleId", { type: "server", message: result.message });
        return;
      }
      if (result.field === "vehicleId") {
        form.setError("vehicleId", { type: "server", message: result.message });
        return;
      }
      setSubmitError(result.message);
    }
  }

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
        <FormField
          control={form.control}
          name="vehicleId"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Vehicle</FormLabel>
              <FormControl>
                <select
                  className="border-input focus-visible:border-ring focus-visible:ring-ring/50 aria-invalid:border-destructive aria-invalid:ring-destructive/20 h-9 w-full rounded-md border bg-transparent px-3 py-1 font-mono text-sm shadow-xs outline-none transition-[color,box-shadow] focus-visible:ring-[3px]"
                  {...field}
                  onChange={(e) => {
                    field.onChange(e);
                    // Reset both vehicle-scoped pickers so a stale pair is never
                    // carried into submit when the vehicle changes.
                    form.setValue("serviceScheduleId", "");
                    form.setValue("expenseLogId", "");
                  }}
                >
                  <option value="">— select a vehicle —</option>
                  {vehicles.map((v) => (
                    <option key={v.id} value={v.id}>
                      {v.registrationNumber}
                    </option>
                  ))}
                </select>
              </FormControl>
              {vehicles.length === 0 ? (
                <FormDescription className="text-status-error">
                  No vehicles on file.{" "}
                  <Link href="/vehicles/new" className="underline underline-offset-4">
                    Register a vehicle
                  </Link>{" "}
                  before recording a service.
                </FormDescription>
              ) : null}
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="serviceScheduleId"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Schedule (optional)</FormLabel>
              <FormControl>
                <select
                  className="border-input focus-visible:border-ring focus-visible:ring-ring/50 aria-invalid:border-destructive aria-invalid:ring-destructive/20 h-9 w-full rounded-md border bg-transparent px-3 py-1 text-sm shadow-xs outline-none transition-[color,box-shadow] focus-visible:ring-[3px] disabled:cursor-not-allowed disabled:opacity-50"
                  disabled={pickerDisabled}
                  {...field}
                >
                  <option value="">— ad-hoc (no schedule) —</option>
                  {eligibleSchedules.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
              </FormControl>
              <FormDescription>
                {pickerDisabled
                  ? "Pick a vehicle to choose a schedule."
                  : "Recording against a schedule advances its “next due” forward by one interval."}
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
                    placeholder="120000"
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
                    placeholder="1234.5"
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
                  className="border-input focus-visible:border-ring focus-visible:ring-ring/50 aria-invalid:border-destructive aria-invalid:ring-destructive/20 h-9 w-full rounded-md border bg-transparent px-3 py-1 text-sm shadow-xs outline-none transition-[color,box-shadow] focus-visible:ring-[3px] disabled:cursor-not-allowed disabled:opacity-50"
                  disabled={pickerDisabled}
                  {...field}
                >
                  <option value="">— no cost link —</option>
                  {eligibleExpenses.map((e) => (
                    <option key={e.id} value={e.id}>
                      {formatNpr(e.amountPaisa)} · {formatNepaliDate(e.date, { format: "bs" })} ·{" "}
                      {EXPENSE_CATEGORY_LABELS[e.category]}
                    </option>
                  ))}
                </select>
              </FormControl>
              <FormDescription>
                {pickerDisabled ? (
                  "Pick a vehicle to link a maintenance / repair expense."
                ) : eligibleExpenses.length === 0 ? (
                  <>
                    No maintenance or repair expense logged for this vehicle yet.{" "}
                    <Link href="/expense-logs/new" className="underline underline-offset-4">
                      Log the expense
                    </Link>{" "}
                    first to link its cost.
                  </>
                ) : (
                  "Links this service to the expense-log row that holds its cost — never a second money column."
                )}
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
            <Link href="/service-records">Cancel</Link>
          </Button>
          <Button type="submit" disabled={form.formState.isSubmitting}>
            {form.formState.isSubmitting ? "Saving…" : "Record service"}
          </Button>
        </div>
      </form>
    </Form>
  );
}
