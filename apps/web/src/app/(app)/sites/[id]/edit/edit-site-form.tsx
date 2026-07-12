"use client";

import { useMemo, useState } from "react";
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
  formatCoord,
  SITE_KIND_OPTIONS,
  type CreateSiteFormValues,
} from "@/lib/sites-schema";

import { updateSiteAction } from "../../actions";
import type { Site } from "../../types";

// Client-only Leaflet map island (Leaflet touches `window` at module load),
// loaded via next/dynamic + ssr:false. The edit form pre-fills it from the
// stored coordinates, so dropping/dragging the pin and typing the coordinate
// inputs write to one source of truth (the form's latitude/longitude values).
// ADR-0047 W5.
const SiteMapEditor = dynamic(() => import("../../site-map-editor").then((m) => m.SiteMapEditor), {
  ssr: false,
  loading: () => (
    <div className="border-border-subtle bg-surface-canvas text-text-muted flex h-80 w-full items-center justify-center rounded-md border text-sm">
      Loading map…
    </div>
  ),
});

// Shared native-<select> styling (mirror of the create form; every token is a
// live @theme utility).
const SELECT_CLASS =
  "border-border-strong focus-visible:border-border-focus focus-visible:ring-border-focus/50 aria-invalid:border-status-error aria-invalid:ring-status-error/20 h-9 w-full rounded-md border bg-transparent px-3 py-1 text-sm shadow-xs outline-none transition-[color,box-shadow] focus-visible:ring-[length:var(--focus-ring-width)]";

interface EditSiteFormProps {
  site: Site;
}

// Edit-site form (ADR-0047 W5). Pre-fills every field from the server-fetched
// site. On submit it computes a diff against the initial values and only PATCHes
// the keys the user actually changed — see DESIGN.md §"Inputs and forms"
// "Diff-against-initial-values for PATCH". Every field is a string in the form;
// the coordinates are pre-filled via formatCoord so the initial string matches
// exactly what the map would emit (so re-dropping the pin at the same spot does
// not register a spurious diff). The full CreateSiteFormSchema is the resolver
// (not a partial) so the "pin required" rule gives immediate client-side
// feedback against the visible shape; the action re-validates the diff and the
// API stays authoritative.
export function EditSiteForm({ site }: EditSiteFormProps): React.ReactElement {
  const [submitError, setSubmitError] = useState<string | null>(null);

  const initialValues: CreateSiteFormValues = useMemo(
    () => ({
      name: site.name,
      kind: site.kind,
      latitude: formatCoord(site.latitude),
      longitude: formatCoord(site.longitude),
      address: site.address ?? "",
      contactName: site.contactName ?? "",
      contactPhone: site.contactPhone ?? "",
    }),
    [site],
  );

  const form = useForm<CreateSiteFormValues>({
    resolver: zodResolver(CreateSiteFormSchema),
    defaultValues: initialValues,
  });

  const latitude = form.watch("latitude");
  const longitude = form.watch("longitude");

  function setPin(lat: string, lng: string): void {
    form.setValue("latitude", lat, { shouldValidate: true, shouldDirty: true });
    form.setValue("longitude", lng, { shouldValidate: true, shouldDirty: true });
  }

  async function onSubmit(values: CreateSiteFormValues): Promise<void> {
    setSubmitError(null);
    form.clearErrors();

    // Diff against the initial values. String comparison works for every field
    // (name, the kind enum, the coordinate strings, the optional strings).
    const changed: Partial<CreateSiteFormValues> = {};
    (Object.keys(values) as (keyof CreateSiteFormValues)[]).forEach((key) => {
      if (values[key] !== initialValues[key]) {
        assignChanged(changed, key, values[key]);
      }
    });

    if (Object.keys(changed).length === 0) {
      setSubmitError("Nothing to update.");
      return;
    }

    const result = await updateSiteAction(site.id, changed);
    if (result && result.ok === false) {
      if (result.field === "name" || result.field === "latitude" || result.field === "longitude") {
        form.setError(result.field, { type: "server", message: result.message });
        return;
      }
      setSubmitError(result.message);
    }
    // On success, updateSiteAction throws NEXT_REDIRECT and the framework
    // navigates us back to /sites/<id>.
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

        <div className="space-y-2">
          <p className="text-text-primary text-sm font-medium">Location</p>
          <SiteMapEditor latitude={latitude} longitude={longitude} onChange={setPin} />
          <p className="text-text-muted text-sm">
            Click the map to move the pin, or drag it to fine-tune. You can also type the
            coordinates below.
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
            <Link href={`/sites/${site.id}`}>Cancel</Link>
          </Button>
          <Button type="submit" disabled={form.formState.isSubmitting}>
            {form.formState.isSubmitting ? "Saving…" : "Save changes"}
          </Button>
        </div>
      </form>
    </Form>
  );
}

// Type-narrow helper for the diff assignment. CreateSiteFormValues is a struct
// of string fields; indexed assignment otherwise widens to never. Mirror of the
// matching helper in the geofences / jobs edit forms.
function assignChanged<K extends keyof CreateSiteFormValues>(
  target: Partial<CreateSiteFormValues>,
  key: K,
  value: CreateSiteFormValues[K],
): void {
  target[key] = value;
}
