"use client";

import { useState } from "react";
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
  SERVICE_INTERVAL_TYPE_OPTIONS,
  SERVICE_SCHEDULE_STATUS_OPTIONS,
  type CreateServiceScheduleFormValues,
} from "@/lib/service-schedules-schema";

import { createServiceScheduleAction } from "../actions";

// A vehicle option for the picker, carrying meterType so the form can give the
// operator immediate feedback on the meter-consistency rule (ADR-0037 c3) before
// the round-trip.
export interface ScheduleVehicleOption {
  id: string;
  registrationNumber: string;
  meterType: "ODOMETER_KM" | "ENGINE_HOURS" | "BOTH";
}

interface CreateServiceScheduleFormProps {
  vehicles: ScheduleVehicleOption[];
}

// Create-service-schedule form (ADR-0037 B5). The shell at ../new/page.tsx
// server-renders the page chrome, gates auth, and pre-fetches the vehicles; this
// component handles input. The server action createServiceScheduleAction
// performs the API call (cookies forward via apiFetch on the server) and
// redirects on success.
//
// Validation timing (per DESIGN.md §"Inputs and forms"): text/number on blur,
// select on change, full form on submit.
//
// THE INTERVAL VALUE follows the type (ADR-0037 c2): its label, unit, and
// step change with intervalType — kilometres / decimal hours / days. The
// last-service anchor is OPTIONAL: leaving it blank lets the API seed it from
// the vehicle's current reading (c4). The anchor meter field shown depends on
// the dimension (odometer for DISTANCE_KM, hours for ENGINE_HOURS, none for
// CALENDAR_DAYS).
//
// THE METER-CONSISTENCY GUARD (c3): an ENGINE_HOURS schedule needs an
// hour-metered vehicle. We check the selected vehicle's meterType on submit and
// show the message on the intervalType input before the round-trip; the API
// re-validates and stays authoritative (its 400 is also routed to intervalType).
export function CreateServiceScheduleForm({
  vehicles,
}: CreateServiceScheduleFormProps): React.ReactElement {
  const [submitError, setSubmitError] = useState<string | null>(null);

  const form = useForm<CreateServiceScheduleFormValues>({
    resolver: zodResolver(CreateServiceScheduleFormSchema),
    defaultValues: {
      vehicleId: "",
      name: "",
      description: "",
      intervalType: "DISTANCE_KM",
      intervalValue: "",
      status: "ACTIVE",
      lastServiceAt: "",
      lastServiceOdometerKm: "",
      lastServiceEngineHours: "",
    },
  });

  const watchedType = form.watch("intervalType");
  const watchedVehicleId = form.watch("vehicleId");
  const selectedVehicle = vehicles.find((v) => v.id === watchedVehicleId);

  async function onSubmit(values: CreateServiceScheduleFormValues): Promise<void> {
    setSubmitError(null);
    form.clearErrors();

    // Client-side meter-consistency guard (the API is still authoritative).
    if (
      values.intervalType === "ENGINE_HOURS" &&
      selectedVehicle &&
      selectedVehicle.meterType === "ODOMETER_KM"
    ) {
      form.setError("intervalType", {
        type: "validate",
        message:
          "This vehicle is metered in kilometres only. An engine-hours schedule needs an hour-metered vehicle.",
      });
      return;
    }

    const result = await createServiceScheduleAction(values);
    if (result && result.ok === false) {
      if (result.field === "name") {
        form.setError("name", { type: "server", message: result.message });
        return;
      }
      if (result.field === "intervalType") {
        form.setError("intervalType", { type: "server", message: result.message });
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
                  before defining a service schedule.
                </FormDescription>
              ) : null}
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="name"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Name</FormLabel>
              <FormControl>
                <Input autoComplete="off" placeholder="250-hour oil & filter service" {...field} />
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
                      // Clear the now-irrelevant anchor meter reading so a stale
                      // value is never carried into submit when the dimension
                      // changes (the action only sends the dimension's own
                      // reading, but this keeps the visible form honest).
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
                    placeholder={
                      watchedType === "DISTANCE_KM"
                        ? "5000"
                        : watchedType === "ENGINE_HOURS"
                          ? "250"
                          : "90"
                    }
                    className="font-mono tabular-nums"
                    {...field}
                  />
                </FormControl>
                <FormDescription>
                  {watchedType === "DISTANCE_KM"
                    ? "Service every N kilometres."
                    : watchedType === "ENGINE_HOURS"
                      ? "Service every N engine-hours (e.g. 250)."
                      : "Service every N days (e.g. 90)."}
                </FormDescription>
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
            Last service (optional)
          </legend>
          <p className="text-text-muted text-xs">
            When this schedule was last serviced. Leave blank to start it from the vehicle&apos;s
            current reading.
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
                      placeholder="120000"
                      className="font-mono tabular-nums"
                      {...field}
                    />
                  </FormControl>
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
                      placeholder="1234.5"
                      className="font-mono tabular-nums"
                      {...field}
                    />
                  </FormControl>
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
            <Link href="/service-schedules">Cancel</Link>
          </Button>
          <Button type="submit" disabled={form.formState.isSubmitting}>
            {form.formState.isSubmitting ? "Creating…" : "Create schedule"}
          </Button>
        </div>
      </form>
    </Form>
  );
}
