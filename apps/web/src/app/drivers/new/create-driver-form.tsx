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
import {
  CreateDriverFormSchema,
  type CreateDriverFormValues,
  DRIVER_STATUS_OPTIONS,
  LICENSE_CLASS_OPTIONS,
} from "@/lib/drivers-schema";

import { createDriverAction } from "../actions";

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

// Six-years-out default for licenseExpiresAt — a Nepali DoTM HMV/HTV
// license is issued for a 5-year term, and the operator's most common
// case is recording a freshly-renewed license. The user adjusts as
// needed. (Vehicles has no equivalent because acquiredAt has no
// natural "default offset"; the create-driver path is the first form
// where prefilling a related date saves keystrokes for the common case.)
function defaultLicenseExpiry(): string {
  const now = new Date();
  const target = new Date(now.getFullYear() + 5, now.getMonth(), now.getDate());
  const y = target.getFullYear();
  const m = String(target.getMonth() + 1).padStart(2, "0");
  const d = String(target.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

// Create-driver form (iter 7). The shell at ../new/page.tsx server-
// renders the page chrome and gates auth; this component handles input.
// The server action createDriverAction performs the API call (so
// cookies forward) and redirects on success — the client only handles
// input validation, submit-in-flight state, and error display.
//
// Validation timing (per DESIGN.md §"Inputs and forms"):
//   - text fields: on blur (RHF default)
//   - select fields: on change (RHF default for native select)
//   - full form: on submit (always)
//
// Native <select> is used instead of a shadcn Select because shadcn's
// Select is Radix-portal-backed and adds setup overhead (z-index,
// portal container, ARIA wiring) disproportionate to a four-option
// dropdown — same calculus as the Vehicles forms.
//
// 409 (duplicate licenseNumber) is surfaced as a field-level error on
// the licenseNumber input (via setError) rather than the generic
// banner, per the iter-7 kickoff item 3.
export function CreateDriverForm(): React.ReactElement {
  const [submitError, setSubmitError] = useState<string | null>(null);

  const form = useForm<CreateDriverFormValues>({
    resolver: zodResolver(CreateDriverFormSchema),
    defaultValues: {
      fullName: "",
      licenseNumber: "",
      licenseClass: "HMV",
      phone: "",
      dateOfBirth: "",
      hiredAt: todayLocalISO(),
      licenseExpiresAt: defaultLicenseExpiry(),
      status: "ACTIVE",
    },
  });

  async function onSubmit(values: CreateDriverFormValues): Promise<void> {
    setSubmitError(null);
    form.clearErrors();
    const result = await createDriverAction(values);
    if (result && result.ok === false) {
      if (result.field === "licenseNumber") {
        form.setError("licenseNumber", { type: "server", message: result.message });
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
          name="fullName"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Full name</FormLabel>
              <FormControl>
                <Input autoComplete="off" placeholder="Ram Bahadur Shrestha" {...field} />
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
                  <Input
                    autoComplete="off"
                    spellCheck={false}
                    className="font-mono"
                    placeholder="03-01-12345678"
                    {...field}
                  />
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
                  <Input
                    type="tel"
                    autoComplete="off"
                    className="font-mono"
                    placeholder="+977-9800000000"
                    {...field}
                  />
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
            <Link href="/drivers">Cancel</Link>
          </Button>
          <Button type="submit" disabled={form.formState.isSubmitting}>
            {form.formState.isSubmitting ? "Creating…" : "Create driver"}
          </Button>
        </div>
      </form>
    </Form>
  );
}
