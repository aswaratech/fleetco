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
import {
  DriverFormSchema,
  type DriverFormValues,
  DRIVER_STATUS_OPTIONS,
  LICENSE_CLASS_OPTIONS,
} from "@/lib/drivers-schema";

import type { Driver } from "../../types";
import { updateDriverAction } from "../../actions";

interface EditDriverFormProps {
  driver: Driver;
}

// Convert an API ISO timestamp to a YYYY-MM-DD string for date-input
// pre-fill. The API returns UTC; we render the UTC date so the user
// sees the same calendar date they entered originally, regardless of
// their browser timezone. (When a future <NepaliDate> component lands
// per DESIGN.md, this collapses into the new component along with the
// matching helper in the Vehicles edit form.)
function isoToDateInput(iso: string | null): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

// Edit-driver form (iter 7). Mirrors the create form's input shape but
// pre-fills every field from the server-fetched driver. On submit it
// computes a diff against the initial values and only PATCHes the keys
// the user actually changed — see DESIGN.md §"Inputs and forms" "Diff-
// against-initial-values for PATCH" for why this matters for the
// terminated-transition rule.
//
// `DriverFormSchema` (the full required shape) is used here, not
// `UpdateDriverFormSchema`, because the form fields are always
// populated and required from the user's perspective; the partial
// semantics apply only to the PATCH payload, not to the rendered form.
//
// Termination handling: the form does NOT render a terminatedAt input.
// The server-side rule (DriversService.update) derives terminatedAt
// from status transitions: ACTIVE→TERMINATED sets it to now;
// TERMINATED→non-TERMINATED clears it. A future "backdate termination"
// affordance would surface terminatedAt explicitly; today the rule
// covers the common cases.
export function EditDriverForm({ driver }: EditDriverFormProps): React.ReactElement {
  const [submitError, setSubmitError] = useState<string | null>(null);

  const initialValues: DriverFormValues = useMemo(
    () => ({
      fullName: driver.fullName,
      licenseNumber: driver.licenseNumber,
      licenseClass: driver.licenseClass,
      phone: driver.phone,
      dateOfBirth: isoToDateInput(driver.dateOfBirth),
      hiredAt: isoToDateInput(driver.hiredAt),
      licenseExpiresAt: isoToDateInput(driver.licenseExpiresAt),
      status: driver.status,
    }),
    [driver],
  );

  const form = useForm<DriverFormValues>({
    resolver: zodResolver(DriverFormSchema),
    defaultValues: initialValues,
  });

  async function onSubmit(values: DriverFormValues): Promise<void> {
    setSubmitError(null);
    form.clearErrors();

    // Compute the diff against the initial values. Only keys whose
    // value strictly differs from the initial value are included in
    // the PATCH payload. Date fields are compared as YYYY-MM-DD
    // strings; enum and text fields as their underlying string value.
    const changed: Partial<DriverFormValues> = {};
    (Object.keys(values) as (keyof DriverFormValues)[]).forEach((key) => {
      if (values[key] !== initialValues[key]) {
        assignChanged(changed, key, values[key]);
      }
    });

    const result = await updateDriverAction(driver.id, changed);
    if (result && result.ok === false) {
      if (result.field === "licenseNumber") {
        form.setError("licenseNumber", { type: "server", message: result.message });
        return;
      }
      setSubmitError(result.message);
    }
    // On success, updateDriverAction throws NEXT_REDIRECT and the
    // framework navigates us back to /drivers — control does not
    // return here.
  }

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
        <FormField
          control={form.control}
          name="fullName"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Full name</FormLabel>
              <FormControl>
                <Input autoComplete="off" {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        <div className="grid gap-4 sm:grid-cols-2">
          <FormField
            control={form.control}
            name="licenseNumber"
            render={({ field }) => (
              <FormItem>
                <FormLabel>License number</FormLabel>
                <FormControl>
                  <Input autoComplete="off" spellCheck={false} className="font-mono" {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="licenseClass"
            render={({ field }) => (
              <FormItem>
                <FormLabel>License class</FormLabel>
                <FormControl>
                  <select
                    className="border-input focus-visible:border-ring focus-visible:ring-ring/50 aria-invalid:border-destructive aria-invalid:ring-destructive/20 h-9 w-full rounded-md border bg-transparent px-3 py-1 text-sm shadow-xs outline-none transition-[color,box-shadow] focus-visible:ring-[3px]"
                    {...field}
                  >
                    {LICENSE_CLASS_OPTIONS.map((opt) => (
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
            name="phone"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Phone</FormLabel>
                <FormControl>
                  <Input type="tel" autoComplete="off" className="font-mono" {...field} />
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
                    {DRIVER_STATUS_OPTIONS.map((opt) => (
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

        <div className="grid gap-4 sm:grid-cols-3">
          <FormField
            control={form.control}
            name="dateOfBirth"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Date of birth (optional)</FormLabel>
                <FormControl>
                  <Input type="date" {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="hiredAt"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Hired at</FormLabel>
                <FormControl>
                  <Input type="date" {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="licenseExpiresAt"
            render={({ field }) => (
              <FormItem>
                <FormLabel>License expires</FormLabel>
                <FormControl>
                  <Input type="date" {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
        </div>

        {submitError ? (
          <p role="alert" className="text-status-error text-sm">
            {submitError}
          </p>
        ) : null}

        <div className="flex items-center justify-end gap-2 pt-2">
          <Button asChild variant="ghost" type="button">
            <Link href={`/drivers/${driver.id}`}>Cancel</Link>
          </Button>
          <Button type="submit" disabled={form.formState.isSubmitting}>
            {form.formState.isSubmitting ? "Saving…" : "Save changes"}
          </Button>
        </div>
      </form>
    </Form>
  );
}

// Type-narrow helper for the diff assignment. DriverFormValues is a
// struct of string fields; indexed assignment otherwise widens to
// never. Keeping the helper local avoids polluting the schema module
// and keeps the form's intent legible. Mirrors the matching helper in
// the Vehicles edit form.
function assignChanged<K extends keyof DriverFormValues>(
  target: Partial<DriverFormValues>,
  key: K,
  value: DriverFormValues[K],
): void {
  target[key] = value;
}
