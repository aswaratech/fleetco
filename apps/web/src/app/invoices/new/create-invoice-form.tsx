"use client";

import { useEffect, useState } from "react";
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
import { CreateInvoiceFormSchema, type CreateInvoiceFormValues } from "@/lib/invoices-schema";

import { createInvoiceAction } from "../actions";
import { INVOICE_SERVICE_TYPE_OPTIONS } from "../types";

export interface CustomerOption {
  id: string;
  name: string;
  status: string;
}

export interface JobOption {
  id: string;
  jobNumber: string;
  customerId: string;
  description: string;
}

interface CreateInvoiceFormProps {
  customers: CustomerOption[];
  jobs: JobOption[];
}

const SELECT_CLASS =
  "border-input focus-visible:border-ring focus-visible:ring-ring/50 aria-invalid:border-destructive aria-invalid:ring-destructive/20 h-9 w-full rounded-md border bg-transparent px-3 py-1 text-sm shadow-xs outline-none transition-[color,box-shadow] focus-visible:ring-[3px]";

// Create-invoice form (D6). Collects the DRAFT header — customer (required),
// optional job (filtered client-side to the chosen customer, the fuel-logs
// vehicle→trip pattern), optional service type, optional discount. On success the
// action redirects to /invoices/<id>/edit where the operator adds lines.
//
// A stale customerId / jobId 400 from the API maps to its picker (result.field);
// other errors fall through to the banner. Native <select> is used for the same
// reason the other forms do (a sub-200 list does not warrant a Radix combobox).
export function CreateInvoiceForm({ customers, jobs }: CreateInvoiceFormProps): React.ReactElement {
  const [submitError, setSubmitError] = useState<string | null>(null);

  const form = useForm<CreateInvoiceFormValues>({
    resolver: zodResolver(CreateInvoiceFormSchema),
    defaultValues: {
      customerId: customers[0]?.id ?? "",
      jobId: "",
      serviceType: "",
      discount: "",
    },
  });

  const customerId = form.watch("customerId");
  const jobId = form.watch("jobId");

  // Jobs available for the chosen customer. When the customer changes and the
  // currently-selected job no longer belongs to them, clear it (the
  // vehicle→trip clearing pattern in the fuel-logs form).
  const customerJobs = jobs.filter((j) => j.customerId === customerId);
  useEffect(() => {
    if (jobId && !customerJobs.some((j) => j.id === jobId)) {
      form.setValue("jobId", "");
    }
  }, [customerId, jobId, customerJobs, form]);

  async function onSubmit(values: CreateInvoiceFormValues): Promise<void> {
    setSubmitError(null);
    form.clearErrors();
    const result = await createInvoiceAction(values);
    if (result && result.ok === false) {
      if (result.field === "customerId" || result.field === "jobId") {
        form.setError(result.field, { type: "server", message: result.message });
        return;
      }
      setSubmitError(result.message);
    }
    // On success the action throws NEXT_REDIRECT (→ /invoices/<id>/edit).
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
                <select className={SELECT_CLASS} {...field}>
                  {customers.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </FormControl>
              <FormDescription>The customer is fixed once the invoice is created.</FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="jobId"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Job (optional)</FormLabel>
              <FormControl>
                <select className={SELECT_CLASS} {...field}>
                  <option value="">— no job —</option>
                  {customerJobs.map((j) => (
                    <option key={j.id} value={j.id}>
                      {j.jobNumber} — {j.description.slice(0, 60)}
                    </option>
                  ))}
                </select>
              </FormControl>
              <FormDescription>
                {customerJobs.length === 0
                  ? "This customer has no jobs on file. You can still bill ad-hoc lines."
                  : "Tag the invoice with a job for provenance. Optional."}
              </FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="serviceType"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Service type</FormLabel>
              <FormControl>
                <select className={SELECT_CLASS} {...field}>
                  <option value="">— set before issuing —</option>
                  {INVOICE_SERVICE_TYPE_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label}
                    </option>
                  ))}
                </select>
              </FormControl>
              <FormDescription>
                Selects the TDS rate. Required before the invoice can be issued; you can set it now
                or on the next screen.
              </FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="discount"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Discount (optional)</FormLabel>
              <FormControl>
                <Input type="number" step="0.01" min="0" placeholder="0.00" {...field} />
              </FormControl>
              <FormDescription>
                An invoice-level discount in NPR applied before VAT. Leave blank for none.
              </FormDescription>
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
            <Link href="/invoices">Cancel</Link>
          </Button>
          <Button type="submit" disabled={form.formState.isSubmitting}>
            {form.formState.isSubmitting ? "Creating…" : "Create draft"}
          </Button>
        </div>
      </form>
    </Form>
  );
}
