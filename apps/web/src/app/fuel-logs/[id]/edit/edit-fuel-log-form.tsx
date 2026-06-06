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
  UpdateFuelLogFormSchema,
  mlToLitersInput,
  paisaToRupeesInput,
  previewTotalCostPaisa,
  type UpdateFuelLogFormInput,
} from "@/lib/fuel-logs-schema";
import { formatNpr } from "@/lib/money";

import { updateFuelLogAction } from "../../actions";
import type { FuelLogDetail } from "../../types";

interface TripOption {
  id: string;
  vehicleId: string;
  status: string;
  vehicle: { id: string; registrationNumber: string };
}

interface EditFuelLogFormProps {
  fuelLog: FuelLogDetail;
  trips: TripOption[];
}

// Edit-fuel-log form (iter 20). Pre-fills every editable field from
// the server-fetched fuel log. On submit it computes a diff against
// the initial values and only PATCHes the keys the user actually
// changed — see DESIGN.md §"Inputs and forms" "Diff-against-initial-
// values for PATCH" for the project-wide pattern. The diff-aware
// design means a PATCH that touches only `pricePerLiter` re-derives
// totalCostPaisa server-side against the stored `litersMl` (the
// service re-runs deriveTotalCostPaisa against the merged shape).
//
// `vehicleId` is intentionally excluded from the editable shape (the
// API's PATCH .strict() rejects it). It is rendered as a read-only
// display row so the operator can see what it is without being able
// to change it — the operator's mental model is that a fuel log
// records a fact about which vehicle was fueled, and rewriting that
// fact would silently rewrite history. A misattributed fill should
// be deleted + re-created against the right vehicle.
//
// `tripId` IS editable — the operator may pair a previously-
// unattributed fill with a trip after the trip is created, or unpair
// a fill if the receipt belongs to a different journey.
//
// Total-cost preview: re-renders as the user types liters or price.
// Uses the same formula as the API's deriveTotalCostPaisa so the
// preview is bit-for-bit the value the API will persist.
export function EditFuelLogForm({ fuelLog, trips }: EditFuelLogFormProps): React.ReactElement {
  const [submitError, setSubmitError] = useState<string | null>(null);

  // The initial values are derived from the persisted row. Liters
  // (mL → "L.LLL") and price per liter (paisa → "R.RR") are converted
  // back into decimal strings for the `<input type="number">`s. The
  // ISO date is sliced down to YYYY-MM-DD for `<input type="date">`.
  const initialValues: UpdateFuelLogFormInput = useMemo(
    () => ({
      tripId: fuelLog.tripId ?? "",
      date: fuelLog.date.slice(0, 10),
      liters: mlToLitersInput(fuelLog.litersMl),
      pricePerLiter: paisaToRupeesInput(fuelLog.pricePerLiterPaisa),
      odometerReadingKm:
        fuelLog.odometerReadingKm !== null ? String(fuelLog.odometerReadingKm) : "",
      station: fuelLog.station ?? "",
      receiptNumber: fuelLog.receiptNumber ?? "",
      notes: fuelLog.notes ?? "",
    }),
    [fuelLog],
  );

  const form = useForm<UpdateFuelLogFormInput>({
    resolver: zodResolver(UpdateFuelLogFormSchema),
    defaultValues: initialValues,
  });

  // Watch liters + price for the total-cost preview.
  const watchedLiters = form.watch("liters");
  const watchedPrice = form.watch("pricePerLiter");

  const previewPaisa = useMemo(() => {
    const litersStr = watchedLiters ?? "";
    const priceStr = watchedPrice ?? "";
    const l = Number(litersStr);
    const p = Number(priceStr);
    return previewTotalCostPaisa(
      litersStr.length > 0 && Number.isFinite(l) ? l : null,
      priceStr.length > 0 && Number.isFinite(p) ? p : null,
    );
  }, [watchedLiters, watchedPrice]);

  async function onSubmit(values: UpdateFuelLogFormInput): Promise<void> {
    setSubmitError(null);
    form.clearErrors();

    // Compute the diff against the initial values. Only keys whose
    // value strictly differs are included. String comparison works
    // for the dates (YYYY-MM-DD), the decimal strings, the cuid
    // (tripId), and the free-form text.
    const changed: Partial<UpdateFuelLogFormInput> = {};
    (Object.keys(values) as (keyof UpdateFuelLogFormInput)[]).forEach((key) => {
      if (values[key] !== initialValues[key]) {
        assignChanged(changed, key, values[key]);
      }
    });

    if (Object.keys(changed).length === 0) {
      setSubmitError("Nothing to update.");
      return;
    }

    const result = await updateFuelLogAction(fuelLog.id, changed);
    if (result && result.ok === false) {
      if (result.field === "tripId") {
        form.setError("tripId", { type: "server", message: result.message });
        return;
      }
      setSubmitError(result.message);
    }
    // On success, updateFuelLogAction throws NEXT_REDIRECT and the
    // framework navigates us back to /fuel-logs/<id>.
  }

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
        {/* Read-only identity row — vehicleId is immutable. Rendered
            with the same visual shape as the editable rows so the
            operator's eye sees the form as one shape. */}
        <div className="space-y-2">
          <span className="text-sm font-medium leading-none">Vehicle</span>
          <Input
            value={fuelLog.vehicle.registrationNumber}
            disabled
            readOnly
            className="font-mono"
          />
        </div>

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
            <Link href={`/fuel-logs/${fuelLog.id}`}>Cancel</Link>
          </Button>
          <Button type="submit" disabled={form.formState.isSubmitting}>
            {form.formState.isSubmitting ? "Saving…" : "Save changes"}
          </Button>
        </div>
      </form>
    </Form>
  );
}

// Type-narrow helper for the diff assignment. UpdateFuelLogFormInput
// is a struct of (mostly) string fields at the input layer; indexed
// assignment otherwise widens to never. Mirror of the matching helper
// in the Jobs edit form.
function assignChanged<K extends keyof UpdateFuelLogFormInput>(
  target: Partial<UpdateFuelLogFormInput>,
  key: K,
  value: UpdateFuelLogFormInput[K],
): void {
  target[key] = value;
}
