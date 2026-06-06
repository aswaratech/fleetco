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
import { NepaliDatePicker } from "@/components/nepali-date-picker";
import { CreateJobFormSchema, type CreateJobFormValues } from "@/lib/jobs-schema";

import { createJobAction } from "../actions";
import { JOB_STATUS_OPTIONS } from "../types";

interface CustomerOption {
  id: string;
  name: string;
  status: string;
}

interface CreateJobFormProps {
  customers: CustomerOption[];
}

// Create-job form (iter 18). The shell at ../new/page.tsx server-
// renders the page chrome, gates auth, and pre-fetches the active-
// customers list for the picker; this component handles input. The
// server action createJobAction performs the API call (so cookies
// forward) and redirects on success — the client only handles input
// validation, submit-in-flight state, and error display.
//
// Validation timing (per DESIGN.md §"Inputs and forms"):
//   - text fields: on blur (RHF default)
//   - select fields: on change (RHF default for native select)
//   - full form: on submit (always)
//
// Native <select> is used for status and customer instead of a shadcn
// Select — same calculus as Customers / Vehicles / Drivers: a Radix-
// portal-backed combobox is disproportionate to a four-option enum or
// a sub-hundred-customer alphabetical list. Promote when the cap is
// approached (the page shell caps at 200).
//
// The four date pairs (scheduled start/end, actual start/end) use the
// <NepaliDatePicker> (ADR-0032 B2), which emits the SAME YYYY-MM-DD
// string the native <input type="date"> did, so the API's
// z.coerce.date() accepts it unchanged and the cross-field end>=start
// rules keep working on the identical string. Server-side cross-field
// validation is duplicated in the form's resolver for immediate
// feedback; the authoritative rule still runs on the API.
//
// 400 with the customer-not-found message is surfaced as a field-level
// error on the customer picker (via setError + result.field ===
// "customerId"); other 400s fall through to the generic banner. 409
// (jobNumber uniqueness — defensive only) maps to a banner since the
// form does not render jobNumber.
export function CreateJobForm({ customers }: CreateJobFormProps): React.ReactElement {
  const [submitError, setSubmitError] = useState<string | null>(null);

  const form = useForm<CreateJobFormValues>({
    resolver: zodResolver(CreateJobFormSchema),
    defaultValues: {
      // Prefill the first customer so the picker isn't empty by
      // default. The shell guarantees customers.length >= 1 (it
      // renders an alternate state otherwise). Status defaults to
      // PLANNED — the most common starting state for a freshly-booked
      // job (the API also defaults to PLANNED server-side).
      customerId: customers[0]?.id ?? "",
      description: "",
      status: "PLANNED",
      scheduledStartDate: "",
      scheduledEndDate: "",
      actualStartDate: "",
      actualEndDate: "",
      notes: "",
    },
  });

  async function onSubmit(values: CreateJobFormValues): Promise<void> {
    setSubmitError(null);
    form.clearErrors();
    const result = await createJobAction(values);
    if (result && result.ok === false) {
      if (result.field === "customerId") {
        form.setError("customerId", { type: "server", message: result.message });
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
          name="customerId"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Customer</FormLabel>
              <FormControl>
                <select
                  className="border-input focus-visible:border-ring focus-visible:ring-ring/50 aria-invalid:border-destructive aria-invalid:ring-destructive/20 h-9 w-full rounded-md border bg-transparent px-3 py-1 text-sm shadow-xs outline-none transition-[color,box-shadow] focus-visible:ring-[3px]"
                  {...field}
                >
                  {customers.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
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
          name="description"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Description</FormLabel>
              <FormControl>
                <textarea
                  rows={3}
                  className="border-input focus-visible:border-ring focus-visible:ring-ring/50 aria-invalid:border-destructive aria-invalid:ring-destructive/20 w-full rounded-md border bg-transparent px-3 py-2 text-sm shadow-xs outline-none transition-[color,box-shadow] focus-visible:ring-[3px]"
                  placeholder="Excavation and grading for the Naxal site."
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
                  {JOB_STATUS_OPTIONS.map((opt) => (
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
            name="scheduledStartDate"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Scheduled start (optional)</FormLabel>
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

          <FormField
            control={form.control}
            name="scheduledEndDate"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Scheduled end (optional)</FormLabel>
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
            name="actualStartDate"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Actual start (optional)</FormLabel>
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

          <FormField
            control={form.control}
            name="actualEndDate"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Actual end (optional)</FormLabel>
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
            <Link href="/jobs">Cancel</Link>
          </Button>
          <Button type="submit" disabled={form.formState.isSubmitting}>
            {form.formState.isSubmitting ? "Creating…" : "Create job"}
          </Button>
        </div>
      </form>
    </Form>
  );
}
