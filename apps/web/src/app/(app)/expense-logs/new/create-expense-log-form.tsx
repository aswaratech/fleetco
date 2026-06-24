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
  CreateExpenseLogFormSchema,
  EXPENSE_CATEGORIES,
  type CreateExpenseLogFormInput,
} from "@/lib/expense-logs-schema";

import { createExpenseLogAction } from "../actions";
import { EXPENSE_CATEGORY_LABELS } from "../types";

interface VehicleOption {
  id: string;
  registrationNumber: string;
  status: string;
}

interface TripOption {
  id: string;
  vehicleId: string;
  status: string;
  vehicle: { id: string; registrationNumber: string };
}

interface CreateExpenseLogFormProps {
  vehicles: VehicleOption[];
  trips: TripOption[];
}

// Create-expense-log form (iter 22). The shell at ../new/page.tsx
// server-renders the page chrome, gates auth, and pre-fetches active
// vehicles + recent trips for the pickers; this component handles
// input. The server action createExpenseLogAction performs the API
// call (cookies forward via apiFetch on the server) and redirects on
// success.
//
// Validation timing (per DESIGN.md §"Inputs and forms"):
//   - text + number fields: on blur (RHF default)
//   - select fields: on change (RHF default for native select)
//   - full form: on submit (always)
//
// Three structural divergences from the Fuel-logs create form shape
// (per the iter-22 kickoff):
//
//   1. amountPaisa is AUTHORITATIVE. The form has a single `amount`
//      decimal field (NPR rupees). NO "Total cost (computed)"
//      preview row — there are no factors to multiply.
//
//   2. The vehicle picker has a leading "— no vehicle —" option that
//      submits "". Choosing it (or having no vehicles to choose
//      from) marks this expense as company-level. When the vehicle
//      picker is "", the trip picker is FORCED to "" and DISABLED —
//      a trip requires a vehicle context. Swapping the vehicle to a
//      different non-empty value also clears the trip pick (to
//      avoid carrying a mismatched pair into submit).
//
//   3. There is a required category select over the eight enum
//      values. Labels via EXPENSE_CATEGORY_LABELS (from types.ts).
//
// 400 with the API's trip-mismatch / vehicle-not-found / trip-not-
// found message surfaces as a field-level error on the right picker
// (via form.setError + result.field). Other 400s fall through to the
// generic banner.
export function CreateExpenseLogForm({
  vehicles,
  trips,
}: CreateExpenseLogFormProps): React.ReactElement {
  const [submitError, setSubmitError] = useState<string | null>(null);

  const form = useForm<CreateExpenseLogFormInput>({
    resolver: zodResolver(CreateExpenseLogFormSchema),
    defaultValues: {
      // Default to "" (no vehicle) so the operator chooses
      // explicitly. Mirror of the Fuel-logs "default to first
      // vehicle" pattern in spirit but inverted: the safe default
      // is "vehicle-agnostic" rather than picking an arbitrary
      // fleet vehicle the operator might not have meant.
      vehicleId: "",
      tripId: "",
      // Default date to today (UTC) — the most common case is an
      // operator logging an expense they paid today. They can
      // change it.
      date: new Date().toISOString().slice(0, 10),
      // Default to MAINTENANCE — the most common category in the
      // CEO's paper ledger. The operator picks the right one before
      // submit.
      category: "MAINTENANCE",
      amount: "",
      vendor: "",
      receiptNumber: "",
      notes: "",
    },
  });

  // Watch the vehicle id so we can (a) filter the trip picker to
  // trips for the currently-selected vehicle and (b) disable the
  // trip picker entirely when no vehicle is chosen.
  const watchedVehicleId = form.watch("vehicleId");

  // Trips whose vehicleId matches the currently-selected vehicle.
  // When the vehicle picker is "", this list is empty (which is
  // fine — the trip picker is disabled in that branch).
  const eligibleTrips = useMemo(
    () => (watchedVehicleId === "" ? [] : trips.filter((t) => t.vehicleId === watchedVehicleId)),
    [trips, watchedVehicleId],
  );

  const tripPickerDisabled = watchedVehicleId === "";

  async function onSubmit(values: CreateExpenseLogFormInput): Promise<void> {
    setSubmitError(null);
    form.clearErrors();
    const result = await createExpenseLogAction(values);
    if (result && result.ok === false) {
      if (result.field === "vehicleId") {
        form.setError("vehicleId", { type: "server", message: result.message });
        return;
      }
      if (result.field === "tripId") {
        form.setError("tripId", { type: "server", message: result.message });
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
              <FormLabel>Vehicle (optional)</FormLabel>
              <FormControl>
                <select
                  className="border-input focus-visible:border-ring focus-visible:ring-ring/50 aria-invalid:border-destructive aria-invalid:ring-destructive/20 h-9 w-full rounded-md border bg-transparent px-3 py-1 font-mono text-sm shadow-xs outline-none transition-[color,box-shadow] focus-visible:ring-[3px]"
                  {...field}
                  onChange={(e) => {
                    field.onChange(e);
                    // Clear the trip pick when the vehicle changes
                    // so we never carry a mismatched pair into
                    // submit. Mirrors the Fuel-logs create form;
                    // additionally fires when switching TO "" (no
                    // vehicle) so the trip picker resets before it
                    // is disabled.
                    form.setValue("tripId", "");
                  }}
                >
                  <option value="">— no vehicle —</option>
                  {vehicles.map((v) => (
                    <option key={v.id} value={v.id}>
                      {v.registrationNumber}
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
          name="tripId"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Trip (optional)</FormLabel>
              <FormControl>
                <select
                  className="border-input focus-visible:border-ring focus-visible:ring-ring/50 aria-invalid:border-destructive aria-invalid:ring-destructive/20 h-9 w-full rounded-md border bg-transparent px-3 py-1 text-sm shadow-xs outline-none transition-[color,box-shadow] focus-visible:ring-[3px] disabled:cursor-not-allowed disabled:opacity-50"
                  disabled={tripPickerDisabled}
                  {...field}
                >
                  <option value="">— no trip —</option>
                  {eligibleTrips.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.id.slice(0, 8)}… · {t.status}
                    </option>
                  ))}
                </select>
              </FormControl>
              {tripPickerDisabled ? (
                <p className="text-text-muted text-xs">Pick a vehicle to enable trip pairing.</p>
              ) : null}
              <FormMessage />
            </FormItem>
          )}
        />

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
                    className="border-input focus-visible:border-ring focus-visible:ring-ring/50 aria-invalid:border-destructive aria-invalid:ring-destructive/20 h-9 w-full rounded-md border bg-transparent px-3 py-1 text-sm shadow-xs outline-none transition-[color,box-shadow] focus-visible:ring-[3px]"
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
                    placeholder="1500.00"
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
                  <Input placeholder="XYZ Auto Workshop Pvt. Ltd." {...field} />
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
                  <Input placeholder="R-12345" className="font-mono" {...field} />
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
            <Link href="/expense-logs">Cancel</Link>
          </Button>
          <Button type="submit" disabled={form.formState.isSubmitting}>
            {form.formState.isSubmitting ? "Saving…" : "Save expense log"}
          </Button>
        </div>
      </form>
    </Form>
  );
}
