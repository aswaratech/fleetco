"use client";

import { useState } from "react";
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
import {
  CreateGeofenceFormSchema,
  GEOFENCE_TYPE_OPTIONS,
  type CreateGeofenceFormValues,
} from "@/lib/geofences-schema";

import { createGeofenceAction } from "../actions";

interface CustomerOption {
  id: string;
  name: string;
}

interface CreateGeofenceFormProps {
  customers: CustomerOption[];
}

// Create-geofence form (ADR-0030 G3). The shell at ../new/page.tsx server-
// renders the page chrome, gates auth, and pre-fetches the customers list;
// this component handles input. The server action createGeofenceAction
// performs the API call (cookies forward via apiFetch on the server) and
// redirects on success — the client handles input validation, submit-in-
// flight state, and error display.
//
// Validation timing (per DESIGN.md §"Inputs and forms"):
//   - text fields: on blur (RHF default)
//   - select fields: on change (RHF default for native select)
//   - full form: on submit (always)
//
// Native <select> for type and customer — same calculus as the other forms:
// a Radix-portal-backed combobox is over-engineering for a three-option enum
// or a sub-hundred-customer list.
//
// THE COORDINATE-ENTRY BOUNDARY (ADR-0030 c1/c8): the boundary is entered as
// the `lon,lat;lon,lat;…` vertex string the API parses — the manual / fallback
// input and the headless-testable path. G4 layers a Leaflet draw editor on top
// that serializes a drawn ring to this SAME string, so this form's contract is
// unchanged when the map lands.
//
// THE CUSTOMER PICKER is shown ONLY for CUSTOMER_SITE. Switching the type away
// from CUSTOMER_SITE clears the picked customer (the API rejects a customerId
// on a DEPOT / ROUTE_CORRIDOR fence), so we never carry a stale owner into
// submit. 400 with the boundary-validity / ownership / stale-customer message
// surfaces as a field-level error on the right input (via form.setError +
// result.field); other 400s fall through to the generic banner.
export function CreateGeofenceForm({ customers }: CreateGeofenceFormProps): React.ReactElement {
  const [submitError, setSubmitError] = useState<string | null>(null);

  const form = useForm<CreateGeofenceFormValues>({
    resolver: zodResolver(CreateGeofenceFormSchema),
    defaultValues: {
      name: "",
      // DEPOT is the most common first fence (the company yard) and needs no
      // customer, so it is the safe default.
      type: "DEPOT",
      boundary: "",
      customerId: "",
    },
  });

  const watchedType = form.watch("type");
  const isCustomerSite = watchedType === "CUSTOMER_SITE";

  async function onSubmit(values: CreateGeofenceFormValues): Promise<void> {
    setSubmitError(null);
    form.clearErrors();
    const result = await createGeofenceAction(values);
    if (result && result.ok === false) {
      if (result.field === "boundary") {
        form.setError("boundary", { type: "server", message: result.message });
        return;
      }
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
          name="name"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Name</FormLabel>
              <FormControl>
                <Input autoComplete="off" placeholder="Balaju yard" {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="type"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Type</FormLabel>
              <FormControl>
                <select
                  className="border-input focus-visible:border-ring focus-visible:ring-ring/50 aria-invalid:border-destructive aria-invalid:ring-destructive/20 h-9 w-full rounded-md border bg-transparent px-3 py-1 text-sm shadow-xs outline-none transition-[color,box-shadow] focus-visible:ring-[3px]"
                  {...field}
                  onChange={(e) => {
                    field.onChange(e);
                    // Clear the customer pick when leaving CUSTOMER_SITE so we
                    // never carry a stale owner into submit (the API rejects a
                    // customerId on a DEPOT / ROUTE_CORRIDOR fence).
                    if (e.target.value !== "CUSTOMER_SITE") {
                      form.setValue("customerId", "");
                      form.clearErrors("customerId");
                    }
                  }}
                >
                  {GEOFENCE_TYPE_OPTIONS.map((opt) => (
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

        {isCustomerSite ? (
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
                    <option value="">— select a customer —</option>
                    {customers.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                </FormControl>
                {customers.length === 0 ? (
                  <FormDescription className="text-status-error">
                    No customers on file.{" "}
                    <Link href="/customers/new" className="underline underline-offset-4">
                      Register a customer
                    </Link>{" "}
                    before defining a customer-site geofence.
                  </FormDescription>
                ) : null}
                <FormMessage />
              </FormItem>
            )}
          />
        ) : null}

        <FormField
          control={form.control}
          name="boundary"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Boundary</FormLabel>
              <FormControl>
                <textarea
                  rows={4}
                  spellCheck={false}
                  className="border-input focus-visible:border-ring focus-visible:ring-ring/50 aria-invalid:border-destructive aria-invalid:ring-destructive/20 w-full rounded-md border bg-transparent px-3 py-2 font-mono text-sm shadow-xs outline-none transition-[color,box-shadow] focus-visible:ring-[3px]"
                  placeholder="85.30,27.70;85.31,27.70;85.31,27.71"
                  {...field}
                />
              </FormControl>
              <FormDescription>
                Vertices as <span className="font-mono">lon,lat</span> pairs separated by{" "}
                <span className="font-mono">;</span> — at least 3, WGS84 (longitude −180…180,
                latitude −90…90). The ring closes automatically. A map editor lands in a later
                slice.
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
            <Link href="/geofences">Cancel</Link>
          </Button>
          <Button type="submit" disabled={form.formState.isSubmitting}>
            {form.formState.isSubmitting ? "Creating…" : "Create geofence"}
          </Button>
        </div>
      </form>
    </Form>
  );
}
