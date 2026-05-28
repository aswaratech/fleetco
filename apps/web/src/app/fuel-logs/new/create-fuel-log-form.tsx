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
import {
  CreateFuelLogFormSchema,
  previewTotalCostPaisa,
  type CreateFuelLogFormInput,
} from "@/lib/fuel-logs-schema";
import { formatNpr } from "@/lib/money";

import { createFuelLogAction } from "../actions";

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

interface CreateFuelLogFormProps {
  vehicles: VehicleOption[];
  trips: TripOption[];
}

// Create-fuel-log form (iter 20). The shell at ../new/page.tsx server-
// renders the page chrome, gates auth, and pre-fetches active vehicles
// + recent trips for the pickers; this component handles input. The
// server action createFuelLogAction performs the API call (cookies
// forward via apiFetch on the server) and redirects on success.
//
// Validation timing (per DESIGN.md §"Inputs and forms"):
//   - text + number fields: on blur (RHF default)
//   - select fields: on change (RHF default for native select)
//   - full form: on submit (always)
//
// Native <select> for vehicle and trip (same calculus as Jobs):
// promoting to combobox is over-engineering until the picker hits the
// 200-item cap. The trip picker is OPTIONAL ("— no trip —" is the
// default) and filtered to trips whose vehicleId matches the
// currently-selected vehicle — so swapping vehicles auto-clears the
// trip picker (the API would reject a mismatched pair with a 400, but
// surfacing the constraint in the UI saves a round-trip).
//
// Units conversion:
//   - The form collects liters as a 3-decimal-place string ("12.345")
//     and price per liter as a 2-decimal-place rupee string ("145.50").
//   - The action layer converts to integer mL / paisa via Math.round.
//   - The form renders a read-only "Total cost" preview computed
//     identically to the API's deriveTotalCostPaisa, so the operator
//     can spot a typo before submitting. The preview re-renders as
//     the user types liters or price.
//
// 400 with the API's trip-mismatch / vehicle-not-found message
// surfaces as a field-level error on the right picker (via
// form.setError + result.field). Other 400s fall through to the
// generic banner.
export function CreateFuelLogForm({ vehicles, trips }: CreateFuelLogFormProps): React.ReactElement {
  const [submitError, setSubmitError] = useState<string | null>(null);

  const form = useForm<CreateFuelLogFormInput>({
    resolver: zodResolver(CreateFuelLogFormSchema),
    defaultValues: {
      // Default to the first vehicle so the picker is never empty.
      // The shell guarantees vehicles.length >= 1 (it renders an
      // alternate state otherwise).
      vehicleId: vehicles[0]?.id ?? "",
      tripId: "",
      // Default date to today (UTC) — the most common case is an
      // operator logging a fill they pumped today. They can change it.
      date: new Date().toISOString().slice(0, 10),
      liters: "",
      pricePerLiter: "",
      odometerReadingKm: "",
      station: "",
      receiptNumber: "",
      notes: "",
    },
  });

  // Watch the vehicle id so we can filter the trip picker; watch
  // liters and pricePerLiter so we can render the total-cost preview.
  const watchedVehicleId = form.watch("vehicleId");
  const watchedLiters = form.watch("liters");
  const watchedPrice = form.watch("pricePerLiter");

  // Trips whose vehicleId matches the currently-selected vehicle. If
  // none, the trip picker still renders with just the "no trip" option.
  const eligibleTrips = useMemo(
    () => trips.filter((t) => t.vehicleId === watchedVehicleId),
    [trips, watchedVehicleId],
  );

  // Read-only preview of totalCostPaisa from the current decimal inputs.
  // Renders as the em-dash when either input is empty or non-numeric;
  // matches formatNpr's null fallback. Same formula as the API; the
  // operator's preview is bit-for-bit the persisted value.
  const previewPaisa = useMemo(() => {
    const l = Number(watchedLiters);
    const p = Number(watchedPrice);
    return previewTotalCostPaisa(
      watchedLiters.length > 0 && Number.isFinite(l) ? l : null,
      watchedPrice.length > 0 && Number.isFinite(p) ? p : null,
    );
  }, [watchedLiters, watchedPrice]);

  async function onSubmit(values: CreateFuelLogFormInput): Promise<void> {
    setSubmitError(null);
    form.clearErrors();
    const result = await createFuelLogAction(values);
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
              <FormLabel>Vehicle</FormLabel>
              <FormControl>
                <select
                  className="border-input focus-visible:border-ring focus-visible:ring-ring/50 aria-invalid:border-destructive aria-invalid:ring-destructive/20 h-9 w-full rounded-md border bg-transparent px-3 py-1 font-mono text-sm shadow-xs outline-none transition-[color,box-shadow] focus-visible:ring-[3px]"
                  {...field}
                  onChange={(e) => {
                    field.onChange(e);
                    // Clear the trip pick when the vehicle changes so
                    // we never carry a mismatched pair into submit.
                    form.setValue("tripId", "");
                  }}
                >
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
                  className="border-input focus-visible:border-ring focus-visible:ring-ring/50 aria-invalid:border-destructive aria-invalid:ring-destructive/20 h-9 w-full rounded-md border bg-transparent px-3 py-1 text-sm shadow-xs outline-none transition-[color,box-shadow] focus-visible:ring-[3px]"
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
                <Input type="date" className="font-mono" {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        <div className="grid gap-4 sm:grid-cols-2">
          <FormField
            control={form.control}
            name="liters"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Liters</FormLabel>
                <FormControl>
                  <Input
                    type="number"
                    step="0.001"
                    min="0.001"
                    inputMode="decimal"
                    placeholder="12.345"
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
            name="pricePerLiter"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Price per liter (NPR)</FormLabel>
                <FormControl>
                  <Input
                    type="number"
                    step="0.01"
                    min="0.01"
                    inputMode="decimal"
                    placeholder="145.50"
                    className="font-mono tabular-nums"
                    {...field}
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
        </div>

        <div className="border-border-subtle bg-surface-canvas rounded border p-3">
          <p className="text-text-muted text-xs font-medium tracking-wide uppercase">
            Total cost (computed)
          </p>
          <p className="text-text-primary mt-1 text-base tabular-nums">{formatNpr(previewPaisa)}</p>
        </div>

        <FormField
          control={form.control}
          name="odometerReadingKm"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Odometer reading, km (optional)</FormLabel>
              <FormControl>
                <Input
                  type="number"
                  step="1"
                  min="0"
                  inputMode="numeric"
                  placeholder="125000"
                  className="font-mono tabular-nums"
                  {...field}
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        <div className="grid gap-4 sm:grid-cols-2">
          <FormField
            control={form.control}
            name="station"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Station (optional)</FormLabel>
                <FormControl>
                  <Input placeholder="Nepal Oil Corp — Kalanki" {...field} />
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
            <Link href="/fuel-logs">Cancel</Link>
          </Button>
          <Button type="submit" disabled={form.formState.isSubmitting}>
            {form.formState.isSubmitting ? "Saving…" : "Save fuel log"}
          </Button>
        </div>
      </form>
    </Form>
  );
}
