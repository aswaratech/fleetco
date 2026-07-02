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
import {
  CreateTrackerFormSchema,
  TRACKER_STATUS_OPTIONS,
  type CreateTrackerFormValues,
} from "@/lib/trackers-schema";

import { updateTrackerAction } from "../../actions";
import type { Tracker } from "../../types";

interface VehicleOption {
  id: string;
  registrationNumber: string;
}

interface EditTrackerFormProps {
  tracker: Tracker;
  vehicles: VehicleOption[];
}

// Convert a stored ISO/UTC timestamp to the YYYY-MM-DD string the date
// picker holds. UTC on purpose: the operator sees the calendar date they
// entered originally regardless of browser timezone (the drivers /
// vehicles edit forms carry the identical helper).
function isoToDateInput(iso: string | null): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

// Edit-tracker form (ADR-0042 M4). Pre-fills every field from the server-
// fetched tracker. On submit it computes a diff against the initial values
// and only PATCHes the keys the user actually changed (DESIGN.md §"Inputs
// and forms" "Diff-against-initial-values for PATCH"). The full
// CreateTrackerFormSchema is the resolver (not a partial) so the
// retirement invariant (RETIRED ⇒ unassigned) gives immediate client-side
// feedback against the visible shape; the action re-validates the diff and
// the API decides the invariant on the merged shape.
//
// NOTE the installedAt reset rule: when the diff changes `vehicleId`
// without touching `installedAt`, the SERVICE clears the stored install
// date (it described the previous mount). The form surfaces that in the
// vehicle picker's description so the operator is not surprised.
export function EditTrackerForm({ tracker, vehicles }: EditTrackerFormProps): React.ReactElement {
  const [submitError, setSubmitError] = useState<string | null>(null);

  const initialValues: CreateTrackerFormValues = useMemo(
    () => ({
      imei: tracker.imei,
      label: tracker.label ?? "",
      simMsisdn: tracker.simMsisdn ?? "",
      status: tracker.status,
      vehicleId: tracker.vehicleId ?? "",
      installedAt: isoToDateInput(tracker.installedAt),
    }),
    [tracker],
  );

  const form = useForm<CreateTrackerFormValues>({
    resolver: zodResolver(CreateTrackerFormSchema),
    defaultValues: initialValues,
  });

  async function onSubmit(values: CreateTrackerFormValues): Promise<void> {
    setSubmitError(null);
    form.clearErrors();

    // Diff against the initial values — string comparison works for every
    // field (imei, label, simMsisdn, the status enum, the vehicleId cuid /
    // "", the YYYY-MM-DD date / "").
    const changed: Partial<CreateTrackerFormValues> = {};
    (Object.keys(values) as (keyof CreateTrackerFormValues)[]).forEach((key) => {
      if (values[key] !== initialValues[key]) {
        assignChanged(changed, key, values[key]);
      }
    });

    if (Object.keys(changed).length === 0) {
      setSubmitError("Nothing to update.");
      return;
    }

    const result = await updateTrackerAction(tracker.id, changed);
    if (result && result.ok === false) {
      if (result.field === "imei") {
        form.setError("imei", { type: "server", message: result.message });
        return;
      }
      if (result.field === "vehicleId") {
        form.setError("vehicleId", { type: "server", message: result.message });
        return;
      }
      setSubmitError(result.message);
    }
    // On success, updateTrackerAction throws NEXT_REDIRECT and the framework
    // navigates back to /trackers/<id>.
  }

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
        <FormField
          control={form.control}
          name="imei"
          render={({ field }) => (
            <FormItem>
              <FormLabel>IMEI</FormLabel>
              <FormControl>
                <Input autoComplete="off" inputMode="numeric" className="font-mono" {...field} />
              </FormControl>
              <FormDescription>
                Change only to correct a mistyped registration — the gateway matches positions by
                this exact number.
              </FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="label"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Label (optional)</FormLabel>
              <FormControl>
                <Input autoComplete="off" {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="simMsisdn"
          render={({ field }) => (
            <FormItem>
              <FormLabel>SIM number (optional)</FormLabel>
              <FormControl>
                <Input autoComplete="off" inputMode="tel" className="font-mono" {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

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
                  {TRACKER_STATUS_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label}
                    </option>
                  ))}
                </select>
              </FormControl>
              <FormDescription>
                Retiring a tracker requires unassigning its vehicle in the same save.
              </FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />

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
                >
                  <option value="">— unassigned (spare) —</option>
                  {vehicles.map((v) => (
                    <option key={v.id} value={v.id}>
                      {v.registrationNumber}
                    </option>
                  ))}
                </select>
              </FormControl>
              <FormDescription>
                Reassigning clears the install date below unless a new one is set in the same save.
              </FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="installedAt"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Installed at (optional)</FormLabel>
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

        {submitError ? (
          <p role="alert" className="text-status-error text-sm">
            {submitError}
          </p>
        ) : null}

        <div className="flex items-center justify-end gap-2 pt-2">
          <Button asChild variant="ghost" type="button">
            <Link href={`/trackers/${tracker.id}`}>Cancel</Link>
          </Button>
          <Button type="submit" disabled={form.formState.isSubmitting}>
            {form.formState.isSubmitting ? "Saving…" : "Save changes"}
          </Button>
        </div>
      </form>
    </Form>
  );
}

// Type-narrow helper for the diff assignment. CreateTrackerFormValues is a
// struct of string fields; indexed assignment otherwise widens to never.
// Mirror of the matching helper in the geofences / drivers edit forms.
function assignChanged<K extends keyof CreateTrackerFormValues>(
  target: Partial<CreateTrackerFormValues>,
  key: K,
  value: CreateTrackerFormValues[K],
): void {
  target[key] = value;
}
