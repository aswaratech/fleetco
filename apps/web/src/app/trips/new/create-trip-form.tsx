"use client";

import { useState } from "react";
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
import { CreateTripFormSchema, type CreateTripFormValues } from "@/lib/trips-schema";

import { TRIP_STATUS_OPTIONS } from "../types";
import { createTripAction } from "../actions";

interface CreateTripFormProps {
  vehicles: { id: string; registrationNumber: string; make: string; model: string }[];
  drivers: { id: string; fullName: string; licenseNumber: string }[];
}

// Create-trip form (iter 9). The shell at ../new/page.tsx fetches the
// active Vehicle + Driver lists server-side and passes them in; this
// component renders the form, runs the resolver, and calls
// createTripAction. The action redirects to the new trip's detail
// page on success.
//
// Layout follows DESIGN.md §"Inputs and forms": labels above inputs,
// related fields grouped (Vehicle/Driver, then Status, then Timing,
// then Odometer, then Notes), primary action right-aligned.
//
// Vehicle and Driver pickers are native <select> for the same reasons
// the Drivers create form uses native select for licenseClass /
// status: shadcn Select is Radix-portal-backed and brings setup
// overhead disproportionate to a list of up to 200 entries. The
// option label is `"<reg> · <make> <model>"` for vehicles (so the
// CEO can disambiguate two trucks with similar reg numbers at a
// glance) and `"<fullName> · <licenseNumber>"` for drivers.
//
// 400 from the API (cross-field rule, FK miss, etc.) surfaces as the
// generic submit-error banner. The cross-field rules also run
// client-side via the schema's superRefine; the banner is the
// fallback for the API-only error paths.
export function CreateTripForm({ vehicles, drivers }: CreateTripFormProps): React.ReactElement {
  const [submitError, setSubmitError] = useState<string | null>(null);

  const form = useForm<CreateTripFormValues>({
    resolver: zodResolver(CreateTripFormSchema),
    defaultValues: {
      vehicleId: "",
      driverId: "",
      status: "PLANNED",
      startedAt: "",
      endedAt: "",
      startOdometerKm: "",
      endOdometerKm: "",
      notes: "",
    },
  });

  async function onSubmit(values: CreateTripFormValues): Promise<void> {
    setSubmitError(null);
    form.clearErrors();
    const result = await createTripAction(values);
    if (result && result.ok === false) {
      setSubmitError(result.message);
    }
    // On success the action throws NEXT_REDIRECT and the framework
    // navigates to /trips/<new-id>; control does not return here.
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
                    <option value="">Pick a vehicle…</option>
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
                    <option value="">Pick a driver…</option>
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
            <Link href="/trips">Cancel</Link>
          </Button>
          <Button type="submit" disabled={form.formState.isSubmitting}>
            {form.formState.isSubmitting ? "Creating…" : "Create trip"}
          </Button>
        </div>
      </form>
    </Form>
  );
}
