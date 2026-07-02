import type { TrackerStatusName } from "@/lib/trackers-schema";

// Web-side view of the API's TrackerDevice row (ADR-0042 M4). Mirrors the
// Prisma model (apps/api/prisma/schema.prisma, model TrackerDevice) at the
// field level. Dates arrive as ISO strings over the JSON wire, so they are
// typed as `string` here, not `Date`.
//
// Unlike the geofences list, every trackers read nests the assigned
// vehicle's registration (a two-field projection, not the whole Vehicle) —
// the API includes it precisely so the list page and the vehicle-detail
// "Tracker" row need no per-row enrichment fetch.
//
// `TrackerStatusName` is re-exported from lib/trackers-schema (the single
// source of truth for the status union + the option/label maps) so a page
// can import the row type and the status union from one module.
export type { TrackerStatusName };

export interface TrackerVehicleRef {
  id: string;
  registrationNumber: string;
}

export interface Tracker {
  id: string;
  imei: string;
  vehicleId: string | null;
  vehicle: TrackerVehicleRef | null;
  label: string | null;
  simMsisdn: string | null;
  status: TrackerStatusName;
  installedAt: string | null;
  createdById: string;
  createdAt: string;
  updatedAt: string;
}
