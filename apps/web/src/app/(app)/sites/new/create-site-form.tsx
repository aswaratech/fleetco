"use client";

import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import dynamic from "next/dynamic";
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
  CreateSiteFormSchema,
  SITE_KIND_OPTIONS,
  type CreateSiteFormValues,
} from "@/lib/sites-schema";

import { createSiteAction } from "../actions";

// The Leaflet map island is client-only — Leaflet references `window` at module
// load — so it loads via next/dynamic with ssr:false and never renders on the
// server (the canonical App Router gotcha). A fixed-height placeholder holds the
// layout while the chunk loads (and doubles as the graceful-degradation state:
// if the chunk fails, the coordinate inputs below still work). ADR-0047 W5.
const SiteMapEditor = dynamic(() => import("../site-map-editor").then((m) => m.SiteMapEditor), {
  ssr: false,
  loading: () => (
    <div className="border-border-subtle bg-surface-canvas text-text-muted flex h-80 w-full items-center justify-center rounded-md border text-sm">
      Loading map…
    </div>
  ),
});

// Shared native-<select> styling (mirrors the geofences / jobs forms — a
// Radix-portal combobox is over-engineering for a five-option enum). Every
// token is a live @theme utility.
const SELECT_CLASS =
  "border-border-strong focus-visible:border-border-focus focus-visible:ring-border-focus/50 aria-invalid:border-status-error aria-invalid:ring-status-error/20 h-9 w-full rounded-md border bg-transparent px-3 py-1 text-sm shadow-xs outline-none transition-[color,box-shadow] focus-visible:ring-[length:var(--focus-ring-width)]";

// Create-site form (ADR-0047 W5). The shell at ../new/page.tsx server-renders
// the page chrome + gates auth; this component handles input. The server action
// createSiteAction performs the API call (cookies forward via apiFetch on the
// server) and redirects on success.
//
// Validation timing (DESIGN.md §"Inputs and forms"): text fields on blur, the
// select on change, the full form on submit.
//
// THE PIN (ADR-0047 c4/c9, DESIGN.md §Sites): the location is entered as a
// single map marker whose position writes the latitude/longitude fields. The
// two coordinate inputs are EDITABLE (tabular-nums) so the operator can
// fine-tune by typing (which re-positions the marker) and so the pin still
// works if the map chunk fails to load — the manual / fallback / headless path,
// mirroring the geofence coordinate textarea. The pin is REQUIRED (a Site is a
// place; the schema requires both coordinates). A 400 with a field message
// surfaces inline on the right input via form.setError + result.field.
export function CreateSiteForm(): React.ReactElement {
  const [submitError, setSubmitError] = useState<string | null>(null);

  const form = useForm<CreateSiteFormValues>({
    resolver: zodResolver(CreateSiteFormSchema),
    defaultValues: {
      name: "",
      // CRUSHER is the first enum value and the archetypal pickup source; the
      // operator switches it for a delivery site / depot.
      kind: "CRUSHER",
      latitude: "",
      longitude: "",
      address: "",
      contactName: "",
      contactPhone: "",
    },
  });

  const latitude = form.watch("latitude");
  const longitude = form.watch("longitude");

  // The map writes both coordinates at once; validate on write so the "pin
  // required" rule clears as soon as a marker exists.
  function setPin(lat: string, lng: string): void {
    form.setValue("latitude", lat, { shouldValidate: true, shouldDirty: true });
    form.setValue("longitude", lng, { shouldValidate: true, shouldDirty: true });
  }

  async function onSubmit(values: CreateSiteFormValues): Promise<void> {
    setSubmitError(null);
    form.clearErrors();
    const result = await createSiteAction(values);
    if (result && result.ok === false) {
      if (result.field === "name" || result.field === "latitude" || result.field === "longitude") {
        form.setError(result.field, { type: "server", message: result.message });
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
                <Input autoComplete="off" placeholder="Kalimati Crusher" {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="kind"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Kind</FormLabel>
              <FormControl>
                <select className={SELECT_CLASS} {...field}>
                  {SITE_KIND_OPTIONS.map((opt) => (
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

        {/* The pin. The map is not a single RHF field (it drives two), so it
            lives outside FormField; the coordinate inputs below carry the
            per-field validation. */}
        <div className="space-y-2">
          <p className="text-text-primary text-sm font-medium">Location</p>
          <SiteMapEditor latitude={latitude} longitude={longitude} onChange={setPin} />
          <p className="text-text-muted text-sm">
            Click the map to drop a pin, or drag it to fine-tune. You can also type the coordinates
            below.
          </p>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <FormField
              control={form.control}
              name="latitude"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Latitude</FormLabel>
                  <FormControl>
                    <Input
                      inputMode="decimal"
                      autoComplete="off"
                      placeholder="27.7172"
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
              name="longitude"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Longitude</FormLabel>
                  <FormControl>
                    <Input
                      inputMode="decimal"
                      autoComplete="off"
                      placeholder="85.3240"
                      className="tabular-nums"
                      {...field}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
          </div>
        </div>

        <FormField
          control={form.control}
          name="address"
          render={({ field }) => (
            <FormItem>
              <FormLabel>
                Address <span className="text-text-muted font-normal">(optional)</span>
              </FormLabel>
              <FormControl>
                <Input autoComplete="off" {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="contactName"
          render={({ field }) => (
            <FormItem>
              <FormLabel>
                Contact name <span className="text-text-muted font-normal">(optional)</span>
              </FormLabel>
              <FormControl>
                <Input autoComplete="off" {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="contactPhone"
          render={({ field }) => (
            <FormItem>
              <FormLabel>
                Contact phone <span className="text-text-muted font-normal">(optional)</span>
              </FormLabel>
              <FormControl>
                <Input inputMode="tel" autoComplete="off" {...field} />
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
            <Link href="/sites">Cancel</Link>
          </Button>
          <Button type="submit" disabled={form.formState.isSubmitting}>
            {form.formState.isSubmitting ? "Creating…" : "Create site"}
          </Button>
        </div>
      </form>
    </Form>
  );
}
