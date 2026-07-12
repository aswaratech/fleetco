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
import { UpdateTripFormSchema, type UpdateTripFormValues } from "@/lib/trips-schema";
import { tenthsToHoursInput } from "@/lib/units";
import { meterIncludesHours, meterIncludesOdometer } from "@/lib/vehicles-schema";

import type { TripDetail, VehicleMeterType } from "../../types";
import { TRIP_STATUS_OPTIONS } from "../../types";
import { TripOrderFields, type SiteOption } from "../../trip-order-fields";
import { updateTripAction } from "../../actions";

interface EditTripFormProps {
  trip: TripDetail;
  vehicles: {
    id: string;
    registrationNumber: string;
    make: string;
    model: string;
    meterType: VehicleMeterType;
  }[];
  drivers: { id: string; fullName: string; licenseNumber: string }[];
  sites: SiteOption[];
}

// Convert an API ISO timestamp to a `YYYY-MM-DDTHH:MM` string the
// datetime-local input understands. The API returns UTC; we render the
// UTC components so the user sees the same wall-clock value they (or
// the prior editor) entered. A future <NepaliDateTime /> component
// will own timezone handling explicitly per DESIGN.md §"BS calendar".
function isoToDateTimeLocal(iso: string | null): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  const hh = String(date.getUTCHours()).padStart(2, "0");
  const mm = String(date.getUTCMinutes()).padStart(2, "0");
  return `${y}-${m}-${d}T${hh}:${mm}`;
}

function numberOrEmpty(value: number | null): string {
  if (value === null) return "";
  return String(value);
}

// Engine-hours (ADR-0036): integer tenths → decimal-hours string for pre-fill,
// or "" when null (a km-only trip). Mirror of numberOrEmpty for the hours pair.
function hoursOrEmpty(tenths: number | null): string {
  return tenths === null ? "" : tenthsToHoursInput(tenths);
}

// Edit-trip form (iter 9). Pre-fills every field from the
// server-fetched trip; on submit, computes a diff against the initial
// values and only PATCHes the keys the user actually changed.
//
// The diff-against-initial pattern is the same as Drivers iter-7's
// edit form, with one extra consideration: the API's status × timing
// cross-field rule operates on the merged shape after PATCH. The
// form sends the MERGED values to the action for validation while
// only sending the DIFF over the wire — the action re-validates the
// merged shape server-side before issuing the PATCH.
export function EditTripForm({
  trip,
  vehicles,
  drivers,
  sites,
}: EditTripFormProps): React.ReactElement {
  const [submitError, setSubmitError] = useState<string | null>(null);

  const initialValues: UpdateTripFormValues = useMemo(
    () => ({
      vehicleId: trip.vehicleId,
      driverId: trip.driverId,
      status: trip.status,
      startedAt: isoToDateTimeLocal(trip.startedAt),
      endedAt: isoToDateTimeLocal(trip.endedAt),
      startOdometerKm: numberOrEmpty(trip.startOdometerKm),
      endOdometerKm: numberOrEmpty(trip.endOdometerKm),
      // Engine-hours capture (ADR-0036). meterType seeds from the trip's
      // current vehicle (re-synced if the operator reassigns); the hours
      // inputs pre-fill from the stored tenths.
      startEngineHours: hoursOrEmpty(trip.startEngineHours),
      endEngineHours: hoursOrEmpty(trip.endEngineHours),
      meterType: trip.vehicle.meterType,
      notes: trip.notes ?? "",
      // Haulage order (ADR-0047 c3). Pre-filled from the trip; "" for unset so
      // the diff omits an untouched field and a cleared field sends null.
      materialType: trip.materialType ?? "",
      materialNote: trip.materialNote ?? "",
      pickupSiteId: trip.pickupSiteId ?? "",
      dropoffSiteId: trip.dropoffSiteId ?? "",
      consigneeName: trip.consigneeName ?? "",
      consigneePhone: trip.consigneePhone ?? "",
      expectedLoadCount: numberOrEmpty(trip.expectedLoadCount),
      specialInstructions: trip.specialInstructions ?? "",
      docketNumber: trip.docketNumber ?? "",
    }),
    [trip],
  );

  const form = useForm<UpdateTripFormValues>({
    resolver: zodResolver(UpdateTripFormSchema),
    defaultValues: initialValues,
  });

  // The selected vehicle's meter drives which reading inputs to show (ADR-0036
  // c7); meterType is synced by the vehicle picker below so the resolver's
  // meter-aware cross-field rule tracks the current selection.
  const meterType = form.watch("meterType");
  const showOdometer = meterIncludesOdometer(meterType ?? "ODOMETER_KM");
  const showHours = meterIncludesHours(meterType ?? "ODOMETER_KM");

  async function onSubmit(values: UpdateTripFormValues): Promise<void> {
    setSubmitError(null);
    form.clearErrors();

    // Compute the diff against the initial values. Only keys whose
    // value strictly differs from the initial value are included in
    // the PATCH payload. Empty strings ("" vs initial "") compare
    // equal so an untouched optional field is not sent.
    const diff: Partial<UpdateTripFormValues> = {};
    (Object.keys(values) as (keyof UpdateTripFormValues)[]).forEach((key) => {
      if (values[key] !== initialValues[key]) {
        assignChanged(diff, key, values[key]);
      }
    });

    if (Object.keys(diff).length === 0) {
      setSubmitError("Nothing to update.");
      return;
    }

    // Pass both the diff (for wire) and the merged shape (for
    // cross-field validation on the server) to the action.
    const result = await updateTripAction(trip.id, diff, values);
    if (result && result.ok === false) {
      setSubmitError(result.message);
    }
  }

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <FormField
            control={form.control}
            name="vehicleId"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Vehicle</FormLabel>
                <FormControl>
                  <select
                    className="border-border-strong focus-visible:border-border-focus focus-visible:ring-border-focus/50 aria-invalid:border-status-error aria-invalid:ring-status-error/20 h-9 w-full rounded-md border bg-transparent px-3 py-1 text-sm shadow-xs outline-none transition-[color,box-shadow] focus-visible:ring-[length:var(--focus-ring-width)]"
                    {...field}
                    onChange={(e) => {
                      field.onChange(e);
                      // Re-sync meterType when the operator reassigns the trip
                      // to a different vehicle, so the reading inputs + the
                      // cross-field rule follow the new vehicle's meter.
                      const picked = vehicles.find((v) => v.id === e.target.value);
                      form.setValue("meterType", picked?.meterType ?? "ODOMETER_KM", {
                        shouldValidate: form.formState.isSubmitted,
                      });
                    }}
                  >
                    {vehicles.map((v) => (
                      <option key={v.id} value={v.id}>
                        {v.registrationNumber} · {v.make} {v.model}
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
            name="driverId"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Driver</FormLabel>
                <FormControl>
                  <select
                    className="border-border-strong focus-visible:border-border-focus focus-visible:ring-border-focus/50 aria-invalid:border-status-error aria-invalid:ring-status-error/20 h-9 w-full rounded-md border bg-transparent px-3 py-1 text-sm shadow-xs outline-none transition-[color,box-shadow] focus-visible:ring-[length:var(--focus-ring-width)]"
                    {...field}
                  >
                    {drivers.map((d) => (
                      <option key={d.id} value={d.id}>
                        {d.fullName} · {d.licenseNumber}
                      </option>
                    ))}
                  </select>
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
        </div>

        <FormField
          control={form.control}
          name="status"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Status</FormLabel>
              <FormControl>
                <select
                  className="border-border-strong focus-visible:border-border-focus focus-visible:ring-border-focus/50 aria-invalid:border-status-error aria-invalid:ring-status-error/20 h-9 w-full rounded-md border bg-transparent px-3 py-1 text-sm shadow-xs outline-none transition-[color,box-shadow] focus-visible:ring-[length:var(--focus-ring-width)]"
                  {...field}
                >
                  {TRIP_STATUS_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label}
                    </option>
                  ))}
                </select>
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        <div className="grid gap-4 sm:grid-cols-2">
          <FormField
            control={form.control}
            name="startedAt"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Started at</FormLabel>
                <FormControl>
                  <Input type="datetime-local" {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="endedAt"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Ended at</FormLabel>
                <FormControl>
                  <Input type="datetime-local" {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
        </div>

        {showOdometer ? (
          <div className="grid gap-4 sm:grid-cols-2">
            <FormField
              control={form.control}
              name="startOdometerKm"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Start odometer (km)</FormLabel>
                  <FormControl>
                    <Input
                      type="number"
                      inputMode="numeric"
                      min={0}
                      max={9_999_999}
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
              name="endOdometerKm"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>End odometer (km)</FormLabel>
                  <FormControl>
                    <Input
                      type="number"
                      inputMode="numeric"
                      min={0}
                      max={9_999_999}
                      className="font-mono tabular-nums"
                      {...field}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
          </div>
        ) : null}

        {/* Engine-hours capture (ADR-0036) — shown only for an hour-metered
            vehicle. Decimal hours; the action converts to integer tenths and
            sends only the changed reading in the diff. */}
        {showHours ? (
          <div className="grid gap-4 sm:grid-cols-2">
            <FormField
              control={form.control}
              name="startEngineHours"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Start engine hours</FormLabel>
                  <FormControl>
                    <Input
                      type="number"
                      inputMode="decimal"
                      min={0}
                      step={0.1}
                      placeholder="1234.5"
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
              name="endEngineHours"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>End engine hours</FormLabel>
                  <FormControl>
                    <Input
                      type="number"
                      inputMode="decimal"
                      min={0}
                      step={0.1}
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
        ) : null}

        <TripOrderFields sites={sites} />

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
            <Link href={`/trips/${trip.id}`}>Cancel</Link>
          </Button>
          <Button type="submit" disabled={form.formState.isSubmitting}>
            {form.formState.isSubmitting ? "Saving…" : "Save changes"}
          </Button>
        </div>
      </form>
    </Form>
  );
}

// Type-narrow diff assignment. Mirrors the helper in
// apps/web/src/app/drivers/[id]/edit/edit-driver-form.tsx.
function assignChanged<K extends keyof UpdateTripFormValues>(
  target: Partial<UpdateTripFormValues>,
  key: K,
  value: UpdateTripFormValues[K],
): void {
  target[key] = value;
}
