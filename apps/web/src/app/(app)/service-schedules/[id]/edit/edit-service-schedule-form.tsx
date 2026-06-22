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
  CreateServiceScheduleFormSchema,
  intervalUnitLabel,
  intervalValueToInput,
  SERVICE_INTERVAL_TYPE_OPTIONS,
  SERVICE_SCHEDULE_STATUS_OPTIONS,
  type CreateServiceScheduleFormValues,
  type UpdateServiceScheduleFormValues,
} from "@/lib/service-schedules-schema";
import { tenthsToHoursInput } from "@/lib/units";

import { updateServiceScheduleAction } from "../../actions";
import type { ServiceSchedule } from "../../types";

interface EditServiceScheduleFormProps {
  schedule: ServiceSchedule;
  // The owning vehicle (immutable on edit) — its registration is shown read-only
  // and its meterType drives the client-side meter-consistency guard.
  vehicle: {
    id: string;
    registrationNumber: string;
    meterType: "ODOMETER_KM" | "ENGINE_HOURS" | "BOTH";
  } | null;
}

// Edit-service-schedule form (ADR-0037 B5). Pre-fills every field from the
// server-fetched schedule, converting the stored integer minor units back to the
// human strings the inputs accept (intervalValueToInput / tenthsToHoursInput).
// On submit it computes a diff against the initial values and only PATCHes the
// changed keys — see DESIGN.md §"Inputs and forms" "Diff-against-initial-values
// for PATCH". vehicleId is immutable (shown read-only, never in the diff). The
// effective intervalType (the changed one, or the unchanged current one) is
// passed to the action so it can convert intervalValue — whose unit depends on
// the type and may be absent from the diff.
//
// The full CreateServiceScheduleFormSchema is the resolver (not a partial) so the
// required-field shape gives immediate client-side feedback against the visible
// values; the action re-validates the diff and the API stays authoritative.
export function EditServiceScheduleForm({
  schedule,
  vehicle,
}: EditServiceScheduleFormProps): React.ReactElement {
  const [submitError, setSubmitError] = useState<string | null>(null);

  const initialValues: CreateServiceScheduleFormValues = useMemo(
    () => ({
      vehicleId: schedule.vehicleId,
      name: schedule.name,
      description: schedule.description ?? "",
      intervalType: schedule.intervalType,
      intervalValue: intervalValueToInput(schedule.intervalType, schedule.intervalValue),
      status: schedule.status,
      // ISO datetime → the YYYY-MM-DD calendar day the picker round-trips.
      lastServiceAt: schedule.lastServiceAt.slice(0, 10),
      lastServiceOdometerKm:
        schedule.lastServiceOdometerKm === null ? "" : String(schedule.lastServiceOdometerKm),
      lastServiceEngineHours:
        schedule.lastServiceEngineHours === null
          ? ""
          : tenthsToHoursInput(schedule.lastServiceEngineHours),
    }),
    [schedule],
  );

  const form = useForm<CreateServiceScheduleFormValues>({
    resolver: zodResolver(CreateServiceScheduleFormSchema),
    defaultValues: initialValues,
  });

  const watchedType = form.watch("intervalType");

  async function onSubmit(values: CreateServiceScheduleFormValues): Promise<void> {
    setSubmitError(null);
    form.clearErrors();

    // Client-side meter-consistency guard (ADR-0037 c3; the API is still
    // authoritative). The vehicle is immutable, so only an intervalType change
    // can introduce an inconsistency.
    if (values.intervalType === "ENGINE_HOURS" && vehicle && vehicle.meterType === "ODOMETER_KM") {
      form.setError("intervalType", {
        type: "validate",
        message:
          "This vehicle is metered in kilometres only. An engine-hours schedule needs an hour-metered vehicle.",
      });
      return;
    }

    // Diff against the initial values; vehicleId is immutable so it is never
    // compared or sent. Each field is a string, so a strict `!==` is the diff.
    const editableKeys: (keyof UpdateServiceScheduleFormValues)[] = [
      "name",
      "description",
      "intervalType",
      "intervalValue",
      "status",
      "lastServiceAt",
      "lastServiceOdometerKm",
      "lastServiceEngineHours",
    ];
    const changed: Partial<UpdateServiceScheduleFormValues> = {};
    for (const key of editableKeys) {
      if (values[key] !== initialValues[key]) {
        assignChanged(changed, key, values[key]);
      }
    }

    // If the type changed but the value string happens to match the old one
    // (e.g. "5000"), force-include intervalValue so the action re-converts it
    // under the NEW type — otherwise the stored minor units would be silently
    // reinterpreted (5000 km vs 5000 tenths = 500 h).
    if ("intervalType" in changed && !("intervalValue" in changed)) {
      changed.intervalValue = values.intervalValue;
    }

    if (Object.keys(changed).length === 0) {
      setSubmitError("Nothing to update.");
      return;
    }

    const result = await updateServiceScheduleAction(schedule.id, changed, values.intervalType);
    if (result && result.ok === false) {
      if (result.field === "name") {
        form.setError("name", { type: "server", message: result.message });
        return;
      }
      if (result.field === "intervalType") {
        form.setError("intervalType", { type: "server", message: result.message });
        return;
      }
      setSubmitError(result.message);
    }
    // On success the action throws NEXT_REDIRECT back to the detail page.
  }

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
        {/* vehicleId is immutable post-create — shown read-only, never edited. */}
        <div className="space-y-1">
          <p className="text-text-muted text-xs font-medium tracking-wide uppercase">Vehicle</p>
          <p className="text-text-primary font-mono text-sm">
            {vehicle?.registrationNumber ?? schedule.vehicleId}
          </p>
          <p className="text-text-muted text-xs">
            The vehicle cannot be changed. Delete and recreate the schedule to move it.
          </p>
        </div>

        <FormField
          control={form.control}
          name="name"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Name</FormLabel>
              <FormControl>
                <Input autoComplete="off" {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="description"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Description (optional)</FormLabel>
              <FormControl>
                <textarea
                  rows={2}
                  className="border-input focus-visible:border-ring focus-visible:ring-ring/50 aria-invalid:border-destructive aria-invalid:ring-destructive/20 w-full rounded-md border bg-transparent px-3 py-2 text-sm shadow-xs outline-none transition-[color,box-shadow] focus-visible:ring-[3px]"
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
            name="intervalType"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Interval type</FormLabel>
                <FormControl>
                  <select
                    className="border-input focus-visible:border-ring focus-visible:ring-ring/50 aria-invalid:border-destructive aria-invalid:ring-destructive/20 h-9 w-full rounded-md border bg-transparent px-3 py-1 text-sm shadow-xs outline-none transition-[color,box-shadow] focus-visible:ring-[3px]"
                    {...field}
                    onChange={(e) => {
                      field.onChange(e);
                      form.setValue("lastServiceOdometerKm", "");
                      form.setValue("lastServiceEngineHours", "");
                      form.clearErrors(["intervalType", "intervalValue"]);
                    }}
                  >
                    {SERVICE_INTERVAL_TYPE_OPTIONS.map((opt) => (
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

          <FormField
            control={form.control}
            name="intervalValue"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Interval ({intervalUnitLabel(watchedType)})</FormLabel>
                <FormControl>
                  <Input
                    type="number"
                    inputMode="decimal"
                    step={watchedType === "ENGINE_HOURS" ? "0.1" : "1"}
                    min={watchedType === "ENGINE_HOURS" ? "0.1" : "1"}
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
          name="status"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Status</FormLabel>
              <FormControl>
                <select
                  className="border-input focus-visible:border-ring focus-visible:ring-ring/50 aria-invalid:border-destructive aria-invalid:ring-destructive/20 h-9 w-full rounded-md border bg-transparent px-3 py-1 text-sm shadow-xs outline-none transition-[color,box-shadow] focus-visible:ring-[3px]"
                  {...field}
                >
                  {SERVICE_SCHEDULE_STATUS_OPTIONS.map((opt) => (
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

        <fieldset className="border-border-subtle space-y-4 rounded border p-4">
          <legend className="text-text-muted px-1 text-xs font-medium tracking-wide uppercase">
            Last service anchor
          </legend>
          <p className="text-text-muted text-xs">
            The denormalized &ldquo;last serviced&rdquo; values &ldquo;next due&rdquo; is derived
            from. Recording a service advances these automatically; edit them here only to correct a
            mistake.
          </p>

          <FormField
            control={form.control}
            name="lastServiceAt"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Last serviced at</FormLabel>
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

          {watchedType === "DISTANCE_KM" ? (
            <FormField
              control={form.control}
              name="lastServiceOdometerKm"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Odometer at last service (km)</FormLabel>
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
                  <FormDescription>Leave blank to clear the odometer anchor.</FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
          ) : null}

          {watchedType === "ENGINE_HOURS" ? (
            <FormField
              control={form.control}
              name="lastServiceEngineHours"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Engine hours at last service</FormLabel>
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
                  <FormDescription>Leave blank to clear the engine-hours anchor.</FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
          ) : null}
        </fieldset>

        {submitError ? (
          <p role="alert" className="text-status-error text-sm">
            {submitError}
          </p>
        ) : null}

        <div className="flex items-center justify-end gap-2 pt-2">
          <Button asChild variant="ghost" type="button">
            <Link href={`/service-schedules/${schedule.id}`}>Cancel</Link>
          </Button>
          <Button type="submit" disabled={form.formState.isSubmitting}>
            {form.formState.isSubmitting ? "Saving…" : "Save changes"}
          </Button>
        </div>
      </form>
    </Form>
  );
}

// Type-narrow helper for the diff assignment. The form values are a struct of
// string fields; indexed assignment otherwise widens to never. Mirror of the
// matching helper in the Geofences / Fuel-logs edit forms.
function assignChanged<K extends keyof UpdateServiceScheduleFormValues>(
  target: Partial<UpdateServiceScheduleFormValues>,
  key: K,
  value: UpdateServiceScheduleFormValues[K],
): void {
  target[key] = value;
}
