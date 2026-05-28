import type { Vehicle } from "../vehicles/types";

// Web-side view of the API's FuelLog rows. Mirrors the Prisma model in
// apps/api/prisma/schema.prisma (model FuelLog) and the API's
// LIST_SELECT / DETAIL_INCLUDE shapes
// (apps/api/src/modules/fuel-logs/fuel-logs.service.ts).
//
// Dates arrive as ISO strings over the JSON wire, so they are typed as
// `string` here rather than `Date` — same convention as the Trips /
// Jobs / Customers web types. Money (paisa) and volume (milliliters)
// stay integers per CLAUDE.md §"Money & units"; formatting happens at
// render time via the lib/money + lib/units helpers.
//
// The list endpoint returns the slim projection (FuelLogListItem —
// vehicle reduced to `{ id, registrationNumber }`, trip reduced to
// `{ id }` or null); the detail endpoint returns FuelLogDetail with
// the full nested Vehicle and (when present) Trip so the detail page
// can render the related-entity blocks and deep-link to /vehicles/<id>
// and /trips/<id>.
//
// Promoting to a shared @fleetco/shared package is deferred until a
// second app (driver app, Phase 2) needs the types. iter 19 is read-
// only; the iter-20 write path adds CreateFuelLogFormSchema /
// UpdateFuelLogFormSchema in apps/web/src/lib/fuel-logs-schema.ts.

// List-endpoint item: the slim Vehicle + Trip projection. Matches the
// API's LIST_SELECT. `trip` is nullable because FuelLog.tripId is
// nullable on the schema.
export interface FuelLogListItem {
  id: string;
  vehicleId: string;
  tripId: string | null;
  date: string;
  litersMl: number;
  pricePerLiterPaisa: number;
  totalCostPaisa: number;
  odometerReadingKm: number | null;
  station: string | null;
  receiptNumber: string | null;
  notes: string | null;
  createdById: string;
  createdAt: string;
  updatedAt: string;
  vehicle: {
    id: string;
    registrationNumber: string;
  };
  trip: {
    id: string;
  } | null;
}

// Detail-endpoint shape: full nested Vehicle (always) + full nested
// Trip (nullable). Reuses the Vehicle type from the sibling slice so a
// Vehicle schema change ripples here automatically. The Trip on a
// FuelLog detail page is rendered minimally (just the id + a deep-link
// to /trips/<id>), so the inline shape is enough; if a future iter
// adds a tripNumber to Trip, swap this to the Trip type from
// ../trips/types.
export interface FuelLogDetail {
  id: string;
  vehicleId: string;
  tripId: string | null;
  date: string;
  litersMl: number;
  pricePerLiterPaisa: number;
  totalCostPaisa: number;
  odometerReadingKm: number | null;
  station: string | null;
  receiptNumber: string | null;
  notes: string | null;
  createdById: string;
  createdAt: string;
  updatedAt: string;
  vehicle: Vehicle;
  trip: {
    id: string;
    vehicleId: string;
    driverId: string;
    status: string;
    startedAt: string | null;
    endedAt: string | null;
    startOdometerKm: number | null;
    endOdometerKm: number | null;
    notes: string | null;
    createdById: string;
    createdAt: string;
    updatedAt: string;
  } | null;
}
