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

import type { TripDetail } from "../../types";
import { TRIP_STATUS_OPTIONS } from "../../types";
import { updateTripAction } from "../../actions";

interface EditTripFormProps {
  trip: TripDetail;
  vehicles: { id: string; registrationNumber: string; make: string; model: string }[];
  drivers: { id: string; fullName: string; licenseNumber: string }[];
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
export function EditTripForm({ trip, vehicles, drivers }: EditTripFormProps): React.ReactElement {
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
      notes: trip.notes ?? "",
    }),
    [trip],
  );

  const form = useForm<UpdateTripFormValues>({
    resolver: zodResolver(UpdateTripFormSchema),
    defaultValues: initialValues,
  });

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
                    className="border-input focus-visible:border-ring focus-visible:ring-ring/50 aria-invalid:border-destructive aria-invalid:ring-destructive/20 h-9 w-full rounded-md border bg-transparent px-3 py-1 text-sm shadow-xs outline-none transition-[color,box-shadow] focus-visible:ring-[3px]"
                    {...field}
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
                    className="border-input focus-visible:border-ring focus-visible:ring-ring/50 aria-invalid:border-destructive aria-invalid:ring-destructive/20 h-9 w-full rounded-md border bg-transparent px-3 py-1 text-sm shadow-xs outline-none transition-[color,box-shadow] focus-visible:ring-[3px]"
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
                  className="border-input focus-visible:border-ring focus-visible:ring-ring/50 aria-invalid:border-destructive aria-invalid:ring-destructive/20 h-9 w-full rounded-md border bg-transparent px-3 py-1 text-sm shadow-xs outline-none transition-[color,box-shadow] focus-visible:ring-[3px]"
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
