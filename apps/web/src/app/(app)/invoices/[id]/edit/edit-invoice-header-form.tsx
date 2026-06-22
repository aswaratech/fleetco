"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";

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
import {
  UpdateInvoiceHeaderFormSchema,
  type UpdateInvoiceHeaderFormValues,
} from "@/lib/invoices-schema";

import { updateInvoiceHeaderAction } from "../../actions";
import { INVOICE_SERVICE_TYPE_OPTIONS } from "../../types";

export interface HeaderJobOption {
  id: string;
  jobNumber: string;
  description: string;
}

interface EditInvoiceHeaderFormProps {
  invoiceId: string;
  jobs: HeaderJobOption[];
  initial: UpdateInvoiceHeaderFormValues;
}

const SELECT_CLASS =
  "border-input focus-visible:border-ring focus-visible:ring-ring/50 aria-invalid:border-destructive aria-invalid:ring-destructive/20 h-9 w-full rounded-md border bg-transparent px-3 py-1 text-sm shadow-xs outline-none transition-[color,box-shadow] focus-visible:ring-[3px]";

// Edit the DRAFT header (D6) — the tax-affecting fields: service type (selects the
// TDS rate, required before issue), the optional discount, and the optional
// provenance job (the customer's jobs). customerId is NOT editable (the UI treats
// an invoice's customer as fixed — see invoices-schema.ts). Diff-against-initial:
// only the changed keys PATCH; "" maps to wire null in the action. On success the
// action returns { ok: true } and the form refreshes so the operator stays on the
// workbench (the tax preview re-renders with the new rate/discount).
export function EditInvoiceHeaderForm({
  invoiceId,
  jobs,
  initial,
}: EditInvoiceHeaderFormProps): React.ReactElement {
  const router = useRouter();
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const initialValues: UpdateInvoiceHeaderFormValues = useMemo(
    () => ({
      jobId: initial.jobId ?? "",
      serviceType: initial.serviceType ?? "",
      discount: initial.discount ?? "",
    }),
    [initial],
  );

  const form = useForm<UpdateInvoiceHeaderFormValues>({
    resolver: zodResolver(UpdateInvoiceHeaderFormSchema),
    defaultValues: initialValues,
  });

  async function onSubmit(values: UpdateInvoiceHeaderFormValues): Promise<void> {
    setSubmitError(null);
    setSaved(false);
    form.clearErrors();

    // Diff against the initial values — only changed keys go on the wire.
    const changed: Partial<UpdateInvoiceHeaderFormValues> = {};
    (Object.keys(values) as (keyof UpdateInvoiceHeaderFormValues)[]).forEach((key) => {
      if (values[key] !== initialValues[key]) changed[key] = values[key];
    });

    if (Object.keys(changed).length === 0) {
      setSaved(true);
      return;
    }

    const result = await updateInvoiceHeaderAction(invoiceId, changed);
    if (result.ok === false) {
      if (result.field === "jobId") {
        form.setError("jobId", { type: "server", message: result.message });
        return;
      }
      setSubmitError(result.message);
      return;
    }
    setSaved(true);
    form.reset(values);
    router.refresh();
  }

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
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
                <FormDescription>Selects the TDS rate. Required to issue.</FormDescription>
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
                <FormDescription>NPR, applied before VAT.</FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />
        </div>

        <FormField
          control={form.control}
          name="jobId"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Job (optional)</FormLabel>
              <FormControl>
                <select className={SELECT_CLASS} {...field}>
                  <option value="">— no job —</option>
                  {jobs.map((j) => (
                    <option key={j.id} value={j.id}>
                      {j.jobNumber} — {j.description.slice(0, 60)}
                    </option>
                  ))}
                </select>
              </FormControl>
              <FormDescription>
                Provenance tag. The job must belong to this customer.
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

        <div className="flex items-center justify-end gap-3 pt-1">
          {saved ? <span className="text-text-muted text-sm">Saved.</span> : null}
          <Button type="submit" variant="outline" disabled={form.formState.isSubmitting}>
            {form.formState.isSubmitting ? "Saving…" : "Save header"}
          </Button>
        </div>
      </form>
    </Form>
  );
}
