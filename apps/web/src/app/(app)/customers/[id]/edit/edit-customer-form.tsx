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
  CustomerFormSchema,
  type CustomerFormValues,
  CUSTOMER_STATUS_OPTIONS,
} from "@/lib/customers-schema";

import type { Customer } from "../../types";
import { updateCustomerAction } from "../../actions";

interface EditCustomerFormProps {
  customer: Customer;
}

// Edit-customer form (iter 16). Mirrors the create form's input shape
// but pre-fills every field from the server-fetched customer. On
// submit it computes a diff against the initial values and only
// PATCHes the keys the user actually changed — see DESIGN.md
// §"Inputs and forms" "Diff-against-initial-values for PATCH" for the
// project-wide pattern. (Customer has no terminated-transition-style
// derived field today, so the diff is purely about minimizing the
// wire payload; iter 17's Jobs surface may introduce a derived field
// at which point the diff-against-initial-values rule also protects
// the server-side rule from being overwritten by unchanged echoes.)
//
// `CustomerFormSchema` (the full required shape) is used here, not
// `UpdateCustomerFormSchema`, because the form fields are always
// populated and required from the user's perspective; the partial
// semantics apply only to the PATCH payload, not to the rendered
// form. Same pattern as the Drivers edit form.
//
// Clearing a previously-entered optional field (contactPerson, email,
// panNumber, address) is supported via emptying the input: the diff
// sees the empty string vs. the initial value, includes the key in
// the changed set, and the action layer translates the empty string
// into a JSON null on the wire so the API's hasOwnProperty branch
// clears the column. Required fields (name, phone) emptied to "" will
// 400 server-side (and fail client-side validation on submit).
export function EditCustomerForm({ customer }: EditCustomerFormProps): React.ReactElement {
  const [submitError, setSubmitError] = useState<string | null>(null);

  const initialValues: CustomerFormValues = useMemo(
    () => ({
      name: customer.name,
      contactPerson: customer.contactPerson ?? "",
      phone: customer.phone,
      email: customer.email ?? "",
      panNumber: customer.panNumber ?? "",
      address: customer.address ?? "",
      status: customer.status,
    }),
    [customer],
  );

  const form = useForm<CustomerFormValues>({
    resolver: zodResolver(CustomerFormSchema),
    defaultValues: initialValues,
  });

  async function onSubmit(values: CustomerFormValues): Promise<void> {
    setSubmitError(null);
    form.clearErrors();

    // Compute the diff against the initial values. Only keys whose
    // value strictly differs from the initial value are included in
    // the PATCH payload. Enum and text fields compare by their
    // underlying string value.
    const changed: Partial<CustomerFormValues> = {};
    (Object.keys(values) as (keyof CustomerFormValues)[]).forEach((key) => {
      if (values[key] !== initialValues[key]) {
        assignChanged(changed, key, values[key]);
      }
    });

    const result = await updateCustomerAction(customer.id, changed);
    if (result && result.ok === false) {
      if (result.field === "panNumber") {
        form.setError("panNumber", { type: "server", message: result.message });
        return;
      }
      setSubmitError(result.message);
    }
    // On success, updateCustomerAction throws NEXT_REDIRECT and the
    // framework navigates us to /customers/<id> — control does not
    // return here.
  }

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
        <FormField
          control={form.control}
          name="name"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Name</FormLabel>
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
            name="contactPerson"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Contact person (optional)</FormLabel>
                <FormControl>
                  <Input autoComplete="off" {...field} />
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
                    {CUSTOMER_STATUS_OPTIONS.map((opt) => (
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
            name="email"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Email (optional)</FormLabel>
                <FormControl>
                  <Input type="email" autoComplete="off" {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
        </div>

        <FormField
          control={form.control}
          name="panNumber"
          render={({ field }) => (
            <FormItem>
              <FormLabel>PAN number (optional)</FormLabel>
              <FormControl>
                <Input autoComplete="off" spellCheck={false} className="font-mono" {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="address"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Address (optional)</FormLabel>
              <FormControl>
                <Input autoComplete="off" {...field} />
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
            <Link href={`/customers/${customer.id}`}>Cancel</Link>
          </Button>
          <Button type="submit" disabled={form.formState.isSubmitting}>
            {form.formState.isSubmitting ? "Saving…" : "Save changes"}
          </Button>
        </div>
      </form>
    </Form>
  );
}

// Type-narrow helper for the diff assignment. CustomerFormValues is a
// struct of string fields; indexed assignment otherwise widens to
// never. Keeping the helper local avoids polluting the schema module
// and keeps the form's intent legible. Mirror of the matching helper
// in the Drivers edit form.
function assignChanged<K extends keyof CustomerFormValues>(
  target: Partial<CustomerFormValues>,
  key: K,
  value: CustomerFormValues[K],
): void {
  target[key] = value;
}
