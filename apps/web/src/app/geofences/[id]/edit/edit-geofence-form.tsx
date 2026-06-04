"use client";

import { useMemo, useState } from "react";
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
  wktToVertexInput,
  type CreateGeofenceFormValues,
} from "@/lib/geofences-schema";

import { updateGeofenceAction } from "../../actions";
import type { Geofence } from "../../types";

interface CustomerOption {
  id: string;
  name: string;
}

interface EditGeofenceFormProps {
  geofence: Geofence;
  customers: CustomerOption[];
}

// Edit-geofence form (ADR-0030 G3). Pre-fills every field from the server-
// fetched geofence. On submit it computes a diff against the initial values
// and only PATCHes the keys the user actually changed — see DESIGN.md
// §"Inputs and forms" "Diff-against-initial-values for PATCH" for the
// project-wide pattern. The diff-aware design means a PATCH that leaves the
// boundary untouched does not re-trigger the API's ST_IsValid gate, and a
// PATCH that touches only one of {type, customerId} re-validates against the
// stored other half (the API decides the type/ownership invariant on the
// merged shape).
//
// All four fields are mutable. The boundary is pre-filled by decoding the
// stored `boundaryWkt` back into the `lon,lat;…` coordinate-entry string via
// wktToVertexInput. The customer picker is shown only for CUSTOMER_SITE;
// switching the type away from it clears the picked customer (the API rejects
// a customerId on a DEPOT / ROUTE_CORRIDOR fence). The full
// CreateGeofenceFormSchema is the resolver (not a partial) so the type ↔
// customer ownership rule gives immediate client-side feedback against the
// visible shape; the action re-validates the diff and the API stays
// authoritative.
export function EditGeofenceForm({
  geofence,
  customers,
}: EditGeofenceFormProps): React.ReactElement {
  const [submitError, setSubmitError] = useState<string | null>(null);

  const initialValues: CreateGeofenceFormValues = useMemo(
    () => ({
      name: geofence.name,
      type: geofence.type,
      // Decode the stored POLYGON((…)) WKT back to the lon,lat;… entry form.
      boundary: wktToVertexInput(geofence.boundaryWkt),
      customerId: geofence.customerId ?? "",
    }),
    [geofence],
  );

  const form = useForm<CreateGeofenceFormValues>({
    resolver: zodResolver(CreateGeofenceFormSchema),
    defaultValues: initialValues,
  });

  const watchedType = form.watch("type");
  const isCustomerSite = watchedType === "CUSTOMER_SITE";

  async function onSubmit(values: CreateGeofenceFormValues): Promise<void> {
    setSubmitError(null);
    form.clearErrors();

    // Compute the diff against the initial values. Only keys whose value
    // strictly differs are included. String comparison works for every field
    // (name, the type enum, the boundary string, the customerId cuid / "").
    const changed: Partial<CreateGeofenceFormValues> = {};
    (Object.keys(values) as (keyof CreateGeofenceFormValues)[]).forEach((key) => {
      if (values[key] !== initialValues[key]) {
        assignChanged(changed, key, values[key]);
      }
    });

    if (Object.keys(changed).length === 0) {
      setSubmitError("Nothing to update.");
      return;
    }

    const result = await updateGeofenceAction(geofence.id, changed);
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
    // On success, updateGeofenceAction throws NEXT_REDIRECT and the framework
    // navigates us back to /geofences/<id>.
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
                    // never carry a stale owner into submit.
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
                    before assigning this geofence.
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
                  {...field}
                />
              </FormControl>
              <FormDescription>
                Vertices as <span className="font-mono">lon,lat</span> pairs separated by{" "}
                <span className="font-mono">;</span> — at least 3, WGS84. The ring closes
                automatically. A map editor lands in a later slice.
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
            <Link href={`/geofences/${geofence.id}`}>Cancel</Link>
          </Button>
          <Button type="submit" disabled={form.formState.isSubmitting}>
            {form.formState.isSubmitting ? "Saving…" : "Save changes"}
          </Button>
        </div>
      </form>
    </Form>
  );
}

// Type-narrow helper for the diff assignment. CreateGeofenceFormValues is a
// struct of string fields; indexed assignment otherwise widens to never.
// Mirror of the matching helper in the Jobs / Fuel-logs edit forms.
function assignChanged<K extends keyof CreateGeofenceFormValues>(
  target: Partial<CreateGeofenceFormValues>,
  key: K,
  value: CreateGeofenceFormValues[K],
): void {
  target[key] = value;
}
