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
  CreateTrackerFormSchema,
  TRACKER_STATUS_OPTIONS,
  type CreateTrackerFormValues,
} from "@/lib/trackers-schema";

import { createTrackerAction } from "../actions";

interface VehicleOption {
  id: string;
  registrationNumber: string;
}

interface CreateTrackerFormProps {
  vehicles: VehicleOption[];
}

// Create-tracker form (ADR-0042 M4). The shell at ../new/page.tsx server-
// renders the page chrome, gates auth, and pre-fetches the vehicles list;
// this component handles input. The server action createTrackerAction
// performs the API call and redirects on success.
//
// Validation timing per DESIGN.md §"Inputs and forms" (text on blur,
// selects on change, full form on submit). Native <select> for status and
// vehicle — the same calculus as the geofences form's pickers.
//
// The retirement invariant (RETIRED ⇒ unassigned) gives immediate inline
// feedback via the schema's superRefine, pinned to the vehicle picker. A
// 409 duplicate-IMEI / occupied-vehicle-slot from the API surfaces as a
// field-level error on the right input (form.setError + result.field);
// other failures fall through to the generic banner.
export function CreateTrackerForm({ vehicles }: CreateTrackerFormProps): React.ReactElement {
  const [submitError, setSubmitError] = useState<string | null>(null);

  const form = useForm<CreateTrackerFormValues>({
    resolver: zodResolver(CreateTrackerFormSchema),
    defaultValues: {
      imei: "",
      label: "",
      simMsisdn: "",
      // SPARE is the safe default: a unit is registered when it arrives,
      // usually before it is mounted on a vehicle.
      status: "SPARE",
      vehicleId: "",
      installedAt: "",
    },
  });

  async function onSubmit(values: CreateTrackerFormValues): Promise<void> {
    setSubmitError(null);
    form.clearErrors();
    const result = await createTrackerAction(values);
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
                <Input
                  autoComplete="off"
                  inputMode="numeric"
                  placeholder="352093081452811"
                  className="font-mono"
                  {...field}
                />
              </FormControl>
              <FormDescription>
                The 15-digit identity printed on the unit (and reported by SMS command). The gateway
                matches incoming positions by this exact number.
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
                <Input autoComplete="off" placeholder="FMC920 unit 1" {...field} />
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
                <Input
                  autoComplete="off"
                  inputMode="tel"
                  placeholder="+977 98XXXXXXXX"
                  className="font-mono"
                  {...field}
                />
              </FormControl>
              <FormDescription>
                The number of the SIM inside the unit — where configuration SMS commands are sent
                and which is topped up monthly.
              </FormDescription>
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
                Only an <span className="font-medium">Active</span> tracker assigned to a vehicle
                feeds positions in; a spare or retired unit's forwards are dropped.
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
                At most one tracker per vehicle — assigning an already-tracked vehicle is rejected.
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
              <FormDescription>When the unit was mounted on the vehicle above.</FormDescription>
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
            <Link href="/trackers">Cancel</Link>
          </Button>
          <Button type="submit" disabled={form.formState.isSubmitting}>
            {form.formState.isSubmitting ? "Registering…" : "Register tracker"}
          </Button>
        </div>
      </form>
    </Form>
  );
}
