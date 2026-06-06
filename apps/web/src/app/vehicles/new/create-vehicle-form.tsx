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
import { NepaliDatePicker } from "@/components/nepali-date-picker";
import {
  CreateVehicleFormSchema,
  type CreateVehicleFormValues,
  INSURANCE_TYPE_OPTIONS,
  VEHICLE_KIND_OPTIONS,
  VEHICLE_STATUS_OPTIONS,
} from "@/lib/vehicles-schema";

import { createVehicleAction } from "./actions";

// Today as YYYY-MM-DD for the date input's default. Uses the local
// timezone so a user in Kathmandu sees their local date by default;
// the API stores the parsed Date as UTC per the project convention.
function todayLocalISO(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

// Create-vehicle form (iter 2). The shell at ../page.tsx server-renders
// the page chrome and gates auth; this component handles input. The
// server action createVehicleAction performs the API call (so cookies
// forward) and redirects on success — the client only handles input
// validation, submit-in-flight state, and error display.
//
// Validation timing (per DESIGN.md §"Inputs and forms"):
//   - text fields: on blur (RHF default)
//   - select fields: on change (RHF default for native select)
//   - full form: on submit (always)
//
// Native <select> is used instead of a shadcn Select because shadcn's
// Select is Radix-portal-backed and adds setup overhead (z-index,
// portal container, ARIA wiring) disproportionate to a six-option
// dropdown. When the iter-3 polish ticket lands a search-filter
// surface, the Combobox / Select primitive copy-paste will be done
// then.
export function CreateVehicleForm(): React.ReactElement {
  const [submitError, setSubmitError] = useState<string | null>(null);

  const form = useForm<CreateVehicleFormValues>({
    resolver: zodResolver(CreateVehicleFormSchema),
    defaultValues: {
      registrationNumber: "",
      kind: "TRUCK",
      make: "",
      model: "",
      year: new Date().getFullYear(),
      status: "ACTIVE",
      odometerStartKm: 0,
      acquiredAt: todayLocalISO(),
      // Compliance metadata (iter 14) — all blank by default; optional.
      bluebookNumber: "",
      bluebookExpiresAt: "",
      insurer: "",
      insurancePolicyNumber: "",
      insuranceType: "",
      insuranceExpiresAt: "",
      routePermitNumber: "",
      routePermitExpiresAt: "",
    },
  });

  async function onSubmit(values: CreateVehicleFormValues): Promise<void> {
    setSubmitError(null);
    // createVehicleAction throws NEXT_REDIRECT on success (caught by
    // Next.js's runtime and turned into navigation); on failure it
    // returns a structured result we surface inline.
    const result = await createVehicleAction(values);
    if (result && result.ok === false) {
      setSubmitError(result.message);
    }
  }

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
        <FormField
          control={form.control}
          name="registrationNumber"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Registration number</FormLabel>
              <FormControl>
                <Input
                  autoComplete="off"
                  spellCheck={false}
                  className="font-mono"
                  placeholder="BA 1 KA 1234"
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
            name="kind"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Kind</FormLabel>
                <FormControl>
                  <select
                    className="border-input focus-visible:border-ring focus-visible:ring-ring/50 aria-invalid:border-destructive aria-invalid:ring-destructive/20 h-9 w-full rounded-md border bg-transparent px-3 py-1 text-sm shadow-xs outline-none transition-[color,box-shadow] focus-visible:ring-[3px]"
                    {...field}
                  >
                    {VEHICLE_KIND_OPTIONS.map((opt) => (
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
            name="status"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Status</FormLabel>
                <FormControl>
                  <select
                    className="border-input focus-visible:border-ring focus-visible:ring-ring/50 aria-invalid:border-destructive aria-invalid:ring-destructive/20 h-9 w-full rounded-md border bg-transparent px-3 py-1 text-sm shadow-xs outline-none transition-[color,box-shadow] focus-visible:ring-[3px]"
                    {...field}
                  >
                    {VEHICLE_STATUS_OPTIONS.map((opt) => (
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
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <FormField
            control={form.control}
            name="make"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Make</FormLabel>
                <FormControl>
                  <Input placeholder="Tata" autoComplete="off" {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="model"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Model</FormLabel>
                <FormControl>
                  <Input placeholder="LPK 2518" autoComplete="off" {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <FormField
            control={form.control}
            name="year"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Year</FormLabel>
                <FormControl>
                  <Input
                    type="number"
                    inputMode="numeric"
                    min={1980}
                    max={new Date().getFullYear() + 1}
                    step={1}
                    className="tabular-nums"
                    {...field}
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="odometerStartKm"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Odometer at acquisition (km)</FormLabel>
                <FormControl>
                  <Input
                    type="number"
                    inputMode="numeric"
                    min={0}
                    step={1}
                    className="tabular-nums"
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
          name="acquiredAt"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Acquired at</FormLabel>
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

        {/* Compliance metadata (iter 14) — Nepal registration documents.
            All optional: a vehicle can be registered before its papers
            are scanned in. Native <select> for insurance type per the
            small-list convention noted above. */}
        <fieldset className="space-y-4 border-t border-border-subtle pt-4">
          <legend className="text-text-secondary text-sm font-medium">Compliance metadata</legend>

          <div className="grid gap-4 sm:grid-cols-2">
            <FormField
              control={form.control}
              name="bluebookNumber"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Bluebook number</FormLabel>
                  <FormControl>
                    <Input autoComplete="off" className="font-mono" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="bluebookExpiresAt"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Bluebook expires at</FormLabel>
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
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <FormField
              control={form.control}
              name="insurer"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Insurer</FormLabel>
                  <FormControl>
                    <Input autoComplete="off" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="insurancePolicyNumber"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Insurance policy number</FormLabel>
                  <FormControl>
                    <Input autoComplete="off" className="font-mono" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <FormField
              control={form.control}
              name="insuranceType"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Insurance type</FormLabel>
                  <FormControl>
                    <select
                      className="border-input focus-visible:border-ring focus-visible:ring-ring/50 aria-invalid:border-destructive aria-invalid:ring-destructive/20 h-9 w-full rounded-md border bg-transparent px-3 py-1 text-sm shadow-xs outline-none transition-[color,box-shadow] focus-visible:ring-[3px]"
                      {...field}
                    >
                      <option value="">—</option>
                      {INSURANCE_TYPE_OPTIONS.map((opt) => (
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
              name="insuranceExpiresAt"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Insurance expires at</FormLabel>
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
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <FormField
              control={form.control}
              name="routePermitNumber"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Route permit number</FormLabel>
                  <FormControl>
                    <Input autoComplete="off" className="font-mono" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="routePermitExpiresAt"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Route permit expires at</FormLabel>
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
          </div>
        </fieldset>

        {submitError ? (
          <p role="alert" className="text-status-error text-sm">
            {submitError}
          </p>
        ) : null}

        <div className="flex items-center justify-end gap-2 pt-2">
          <Button asChild variant="ghost" type="button">
            <Link href="/vehicles">Cancel</Link>
          </Button>
          <Button type="submit" disabled={form.formState.isSubmitting}>
            {form.formState.isSubmitting ? "Creating…" : "Create vehicle"}
          </Button>
        </div>
      </form>
    </Form>
  );
}
