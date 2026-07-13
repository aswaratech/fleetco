"use client";

import Link from "next/link";
import { useFormContext } from "react-hook-form";

import { FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

import { MATERIAL_TYPE_OPTIONS } from "./types";

// The reusable dispatch "Order" section (ADR-0047 c1/c3, DESIGN §"Trip dispatch"):
// material (+ a note when Other), pickup/drop-off Site pickers, consignee, load
// count, special instructions, and docket. Shared by the create and edit trip
// forms — kept in ONE place so the two forms cannot drift on the order fields the
// way the five TripStatus mirrors must be kept in lock-step. It composes only
// existing primitives (native <select>, <Input>, <Textarea>) — no new component
// or token — and reads the enclosing form via useFormContext, so each form wires
// it inside its own <Form> provider with its own typed values.
//
// The order fields are optional at the field layer; the OFFERED-order cross-field
// rule in @/lib/trips-schema.ts requires material + pickup + drop-off when the
// status is OFFERED (the API is authoritative).

export interface SiteOption {
  id: string;
  name: string;
}

// The order fields both CreateTripFormValues and UpdateTripFormValues carry (all
// optional strings). Read through useFormContext so the section is form-agnostic.
interface OrderFieldValues {
  materialType?: string;
  materialNote?: string;
  pickupSiteId?: string;
  dropoffSiteId?: string;
  consigneeName?: string;
  consigneePhone?: string;
  expectedLoadCount?: string;
  specialInstructions?: string;
  docketNumber?: string;
}

// The native-<select> class string used across the trip/jobs forms, verbatim.
const SELECT_CLASS =
  "border-border-strong focus-visible:border-border-focus focus-visible:ring-border-focus/50 aria-invalid:border-status-error aria-invalid:ring-status-error/20 h-9 w-full rounded-md border bg-transparent px-3 py-1 text-sm shadow-xs outline-none transition-[color,box-shadow] focus-visible:ring-[length:var(--focus-ring-width)]";

export function TripOrderFields({ sites }: { sites: SiteOption[] }): React.ReactElement {
  const form = useFormContext<OrderFieldValues>();
  const materialType = form.watch("materialType");

  return (
    <div className="border-border-subtle space-y-4 border-t pt-4">
      <h3 className="text-text-primary text-sm font-semibold">Order</h3>

      <div className="grid gap-4 sm:grid-cols-2">
        <FormField
          control={form.control}
          name="materialType"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Material</FormLabel>
              <FormControl>
                <select className={SELECT_CLASS} {...field}>
                  <option value="">Pick a material…</option>
                  {MATERIAL_TYPE_OPTIONS.map((opt) => (
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

        {materialType === "OTHER" ? (
          <FormField
            control={form.control}
            name="materialNote"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Material note</FormLabel>
                <FormControl>
                  <Input placeholder="Describe the material" {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
        ) : null}
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <FormField
          control={form.control}
          name="pickupSiteId"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Pickup site</FormLabel>
              <FormControl>
                <select className={SELECT_CLASS} {...field}>
                  <option value="">Pick a pickup site…</option>
                  {sites.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
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
          name="dropoffSiteId"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Drop-off site</FormLabel>
              <FormControl>
                <select className={SELECT_CLASS} {...field}>
                  <option value="">Pick a drop-off site…</option>
                  {sites.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
      </div>

      <p className="text-text-muted text-sm">
        Missing a site?{" "}
        <Link
          href="/sites/new"
          className="text-text-secondary hover:text-text-primary underline underline-offset-2"
        >
          ＋ New site
        </Link>
      </p>

      <div className="grid gap-4 sm:grid-cols-2">
        <FormField
          control={form.control}
          name="consigneeName"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Consignee name</FormLabel>
              <FormControl>
                <Input {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="consigneePhone"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Consignee phone</FormLabel>
              <FormControl>
                <Input type="tel" inputMode="tel" {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <FormField
          control={form.control}
          name="expectedLoadCount"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Expected load count</FormLabel>
              <FormControl>
                <Input
                  type="number"
                  inputMode="numeric"
                  min={1}
                  max={100000}
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
          name="docketNumber"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Docket number</FormLabel>
              <FormControl>
                <Input {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
      </div>

      <FormField
        control={form.control}
        name="specialInstructions"
        render={({ field }) => (
          <FormItem>
            <FormLabel>Special instructions</FormLabel>
            <FormControl>
              <Textarea rows={3} {...field} />
            </FormControl>
            <FormMessage />
          </FormItem>
        )}
      />
    </div>
  );
}
