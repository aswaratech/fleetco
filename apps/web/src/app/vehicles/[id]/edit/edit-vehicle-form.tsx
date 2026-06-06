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
  VehicleFormSchema,
  type VehicleFormValues,
  INSURANCE_TYPE_OPTIONS,
  VEHICLE_KIND_OPTIONS,
  VEHICLE_STATUS_OPTIONS,
} from "@/lib/vehicles-schema";

import type { Vehicle } from "../../types";
import { updateVehicleAction } from "../actions";

interface EditVehicleFormProps {
  vehicle: Vehicle;
}

// Convert an API ISO timestamp to a YYYY-MM-DD string for date-input
// pre-fill. The API returns UTC; we render the UTC date so the user
// sees the same calendar date they entered originally, regardless of
// their browser timezone. (When a future <NepaliDate> component lands
// per DESIGN.md, this and the create form's `todayLocalISO` collapse
// into the new component.)
function isoToDateInput(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

// Nullable-ISO → date-input string. Compliance dates (iter 14) are
// nullable on the API; a null renders as an empty date input.
function nullableIsoToDateInput(iso: string | null): string {
  return iso ? isoToDateInput(iso) : "";
}

// Edit-vehicle form (iter 3). Mirrors the create form's input shape but
// pre-fills every field from the server-fetched vehicle. On submit it
// computes a diff against the initial values and only PATCHes the keys
// the user actually changed — see DESIGN.md §"Inputs and forms" "Diff-
// against-initial-values for PATCH" for why this matters for the
// retirement-transition rule.
//
// `VehicleFormSchema` (the full required shape) is used here, not
// `UpdateVehicleFormSchema`, because the form fields are always
// populated and required from the user's perspective; the partial
// semantics apply only to the PATCH payload, not to the rendered form.
export function EditVehicleForm({ vehicle }: EditVehicleFormProps): React.ReactElement {
  const [submitError, setSubmitError] = useState<string | null>(null);

  const initialValues: VehicleFormValues = useMemo(
    () => ({
      registrationNumber: vehicle.registrationNumber,
      kind: vehicle.kind,
      make: vehicle.make,
      model: vehicle.model,
      year: vehicle.year,
      status: vehicle.status,
      odometerStartKm: vehicle.odometerStartKm,
      odometerCurrentKm: vehicle.odometerCurrentKm,
      acquiredAt: isoToDateInput(vehicle.acquiredAt),
      // Compliance metadata (iter 14) — null → "" so the inputs are
      // controlled and the diff treats "unchanged null" as "".
      bluebookNumber: vehicle.bluebookNumber ?? "",
      bluebookExpiresAt: nullableIsoToDateInput(vehicle.bluebookExpiresAt),
      insurer: vehicle.insurer ?? "",
      insurancePolicyNumber: vehicle.insurancePolicyNumber ?? "",
      insuranceType: vehicle.insuranceType ?? "",
      insuranceExpiresAt: nullableIsoToDateInput(vehicle.insuranceExpiresAt),
      routePermitNumber: vehicle.routePermitNumber ?? "",
      routePermitExpiresAt: nullableIsoToDateInput(vehicle.routePermitExpiresAt),
    }),
    [vehicle],
  );

  const form = useForm<VehicleFormValues>({
    resolver: zodResolver(VehicleFormSchema),
    defaultValues: initialValues,
  });

  async function onSubmit(values: VehicleFormValues): Promise<void> {
    setSubmitError(null);

    // Compute the diff against the initial values. Only keys whose
    // value strictly differs from the initial value are included in
    // the PATCH payload. acquiredAt is compared as YYYY-MM-DD string;
    // numeric coercion has already happened by the time the resolver
    // ran, so year/odometer comparisons are number-vs-number.
    const changed: Partial<VehicleFormValues> = {};
    (Object.keys(values) as (keyof VehicleFormValues)[]).forEach((key) => {
      if (values[key] !== initialValues[key]) {
        // Type-narrow assignment: VehicleFormValues fields are a union
        // of string and number; the index access widens to the union,
        // so we assign through a typed helper.
        assignChanged(changed, key, values[key]);
      }
    });

    const result = await updateVehicleAction(vehicle.id, changed);
    if (result && result.ok === false) {
      setSubmitError(result.message);
    }
    // On success, updateVehicleAction throws NEXT_REDIRECT and the
    // framework navigates us back to /vehicles — control does not
    // return here.
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
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
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

          <FormField
            control={form.control}
            name="odometerCurrentKm"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Odometer current (km)</FormLabel>
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

        {/* Compliance metadata (iter 14). Same section as the create
            form. Clearing a field (emptying the input) sends null to
            the API via the edit action's empty-string→null mapping. */}
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
            <Link href={`/vehicles/${vehicle.id}`}>Cancel</Link>
          </Button>
          <Button type="submit" disabled={form.formState.isSubmitting}>
            {form.formState.isSubmitting ? "Saving…" : "Save changes"}
          </Button>
        </div>
      </form>
    </Form>
  );
}

// Type-narrow helper for the diff assignment. VehicleFormValues is a
// struct of string|number fields; indexed assignment otherwise widens
// to never. Keeping the helper local avoids polluting the schema
// module and keeps the form's intent legible.
function assignChanged<K extends keyof VehicleFormValues>(
  target: Partial<VehicleFormValues>,
  key: K,
  value: VehicleFormValues[K],
): void {
  target[key] = value;
}
