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
  CreateCustomerFormSchema,
  type CreateCustomerFormValues,
  CUSTOMER_STATUS_OPTIONS,
} from "@/lib/customers-schema";

import { createCustomerAction } from "../actions";

// Create-customer form (iter 16). The shell at ../new/page.tsx
// server-renders the page chrome and gates auth; this component
// handles input. The server action createCustomerAction performs the
// API call (so cookies forward) and redirects on success — the client
// only handles input validation, submit-in-flight state, and error
// display.
//
// Validation timing (per DESIGN.md §"Inputs and forms"):
//   - text fields: on blur (RHF default)
//   - select fields: on change (RHF default for native select)
//   - full form: on submit (always)
//
// Native <select> is used instead of a shadcn Select because shadcn's
// Select is Radix-portal-backed and adds setup overhead (z-index,
// portal container, ARIA wiring) disproportionate to a two-option
// dropdown — same calculus as the Vehicles and Drivers forms.
//
// 409 (duplicate panNumber) is surfaced as a field-level error on the
// panNumber input (via setError) rather than the generic banner — same
// pattern as Drivers iter 7 for licenseNumber. The API's response body
// carries `field: "panNumber"`; the action layer forwards that token
// on ActionError.field.
export function CreateCustomerForm(): React.ReactElement {
  const [submitError, setSubmitError] = useState<string | null>(null);

  const form = useForm<CreateCustomerFormValues>({
    resolver: zodResolver(CreateCustomerFormSchema),
    defaultValues: {
      name: "",
      contactPerson: "",
      phone: "",
      email: "",
      panNumber: "",
      address: "",
      status: "ACTIVE",
    },
  });

  async function onSubmit(values: CreateCustomerFormValues): Promise<void> {
    setSubmitError(null);
    form.clearErrors();
    const result = await createCustomerAction(values);
    if (result && result.ok === false) {
      if (result.field === "panNumber") {
        form.setError("panNumber", { type: "server", message: result.message });
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
          name="name"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Name</FormLabel>
              <FormControl>
                <Input autoComplete="off" placeholder="Sagarmatha Builders Pvt. Ltd." {...field} />
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
                  <Input autoComplete="off" placeholder="Ram Bahadur Shrestha" {...field} />
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
            name="email"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Email (optional)</FormLabel>
                <FormControl>
                  <Input
                    type="email"
                    autoComplete="off"
                    placeholder="accounts@example.com"
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
          name="panNumber"
          render={({ field }) => (
            <FormItem>
              <FormLabel>PAN number (optional)</FormLabel>
              <FormControl>
                <Input
                  autoComplete="off"
                  spellCheck={false}
                  className="font-mono"
                  placeholder="601234567"
                  {...field}
                />
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
                <Input autoComplete="off" placeholder="Naxal, Kathmandu" {...field} />
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
            <Link href="/customers">Cancel</Link>
          </Button>
          <Button type="submit" disabled={form.formState.isSubmitting}>
            {form.formState.isSubmitting ? "Creating…" : "Create customer"}
          </Button>
        </div>
      </form>
    </Form>
  );
}
