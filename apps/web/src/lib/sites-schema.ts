import { z } from "zod";

// Web-side form schemas + display helpers + the coordinate ↔ string bridge for
// the Sites slice (ADR-0047 W5 — the reusable pinned-location aggregate's admin
// surface). Mirrors the API's authoritative schemas
// (apps/api/src/modules/sites/sites.schemas.ts) at the field level. The API is
// authoritative; these give the operator immediate inline feedback before a
// round-trip.
//
// Duplication-budget rationale matches geofences-schema.ts / customers-schema.ts:
// a shared workspace package is deferred; the API rejects anything sent
// incorrectly, so client drift is a UX cost, not a correctness one. The shared
// package becomes worthwhile when a second app needs these shapes.
//
// A Site is a geographic PIN, not the polygon Geofence: its position is two
// SEPARATE scalar fields — `latitude` / `longitude` — never a vertex string.
// The map island (site-map-editor.tsx) drops a single marker whose lat/lng
// populate these fields, and typing a coordinate re-centers the marker. THE X,Y
// FOOT-GUN (the same one the geofence tests pin): Leaflet's `LatLng` is
// `{ lat, lng }` — latitude first — while PostGIS/WKT is longitude-first. Here
// the two are separate NAMED scalars, so there is no positional order to get
// wrong on the wire (map lat→latitude, lng→longitude); the only place order
// matters is inside the map island, guarded there. The form holds each
// coordinate as a STRING (a DOM input / the marker's formatted position); the
// action converts it to a JSON number for the API. `formatCoord` / `parseLatLng`
// are the pure map↔string bridge, pinned by sites-schema.test.ts.

// SiteKind — mirrors the Prisma SiteKind enum + the API's SITE_KINDS list.
// Single source of truth for the web side; the `Site` row type
// (app/(app)/sites/types.ts) imports SiteKindName from here so a new kind is
// added in one place. Order matches the Prisma enum; it has no runtime
// significance.
export const SITE_KINDS = ["CRUSHER", "PIT", "DELIVERY_SITE", "DEPOT", "OTHER"] as const;
export type SiteKindName = (typeof SITE_KINDS)[number];

// Display options for the <select>s and the filter toolbar; the label map is
// derived so a new kind is added in one place (mirror of GEOFENCE_TYPE_OPTIONS).
export const SITE_KIND_OPTIONS = [
  { value: "CRUSHER", label: "Crusher" },
  { value: "PIT", label: "Pit" },
  { value: "DELIVERY_SITE", label: "Delivery site" },
  { value: "DEPOT", label: "Depot" },
  { value: "OTHER", label: "Other" },
] as const;

export const SITE_KIND_LABELS: Record<string, string> = Object.fromEntries(
  SITE_KIND_OPTIONS.map(({ value, label }) => [value, label]),
);

// Coordinate bounds — mirror the API's Latitude / Longitude (WGS84 decimal
// degrees). When the API bounds change, this file changes in the same commit.
export const LATITUDE_MIN = -90;
export const LATITUDE_MAX = 90;
export const LONGITUDE_MIN = -180;
export const LONGITUDE_MAX = 180;

/**
 * Validate a single latitude string the same way the API's Latitude schema
 * validates the parsed number, so the operator gets the same rejection inline
 * before the round-trip. Returns an error message, or null when valid.
 * `Number(...)` tolerates surrounding whitespace, matching the API. The API
 * remains authoritative; this is for immediate feedback only.
 */
export function validateLatitude(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return "Latitude is required.";
  const n = Number(trimmed);
  if (!Number.isFinite(n)) return "Latitude must be a number.";
  if (n < LATITUDE_MIN || n > LATITUDE_MAX) {
    return `Latitude must be between ${LATITUDE_MIN} and ${LATITUDE_MAX}.`;
  }
  return null;
}

/**
 * Validate a single longitude string. Mirror of validateLatitude with the
 * [-180, 180] bound.
 */
export function validateLongitude(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return "Longitude is required.";
  const n = Number(trimmed);
  if (!Number.isFinite(n)) return "Longitude must be a number.";
  if (n < LONGITUDE_MIN || n > LONGITUDE_MAX) {
    return `Longitude must be between ${LONGITUDE_MIN} and ${LONGITUDE_MAX}.`;
  }
  return null;
}

// Coordinate precision for the serialized marker position. 6 decimal places is
// ~0.11 m at the equator — far finer than any site pin needs — and it trims the
// float noise a freehand map drop produces (e.g. 85.30000000000001 → "85.3").
const COORD_DECIMALS = 6;

/**
 * Format a coordinate number to at most COORD_DECIMALS decimal places with
 * trailing zeros stripped, so 85.3 stays "85.3" (not "85.300000"). Mirror of
 * geofence-latlng.ts's formatCoord. `Number(...).toString()` never emits
 * exponential notation for WGS84-range values (|n| ≤ 180), so the output is
 * always a plain decimal the coordinate inputs and the API accept.
 */
export function formatCoord(n: number): string {
  return Number(n.toFixed(COORD_DECIMALS)).toString();
}

/**
 * Parse a (latitude, longitude) STRING pair into a `[lat, lng]` number tuple
 * for the map island to place its marker, or null when either coordinate is
 * not a valid WGS84 value (delegating the bounds rules to validateLatitude /
 * validateLongitude, the single source of truth shared with the coordinate
 * inputs). A defensive fallback so a mid-typing or out-of-range value leaves
 * the marker unplaced (Kathmandu default view) rather than throwing. The tuple
 * order is [lat, lng] — the order Leaflet's LatLng and MapContainer center
 * expect — so a swapped call would put the marker in the wrong hemisphere;
 * pinned by an explicit order assertion in the test.
 */
export function parseLatLng(latRaw: string, lngRaw: string): [number, number] | null {
  if (validateLatitude(latRaw) !== null || validateLongitude(lngRaw) !== null) {
    return null;
  }
  return [Number(latRaw.trim()), Number(lngRaw.trim())];
}

// ---------------------------------------------------------------------
// Form schemas.
// ---------------------------------------------------------------------

// Name bounds mirror the API's Name (trim, 1..256). 256 is loose to
// accommodate Nepali transliterated site names (e.g. "Kalimati Crusher").
const Name = z.string().trim().min(1, "Name is required.").max(256, "Name is too long.");

const SiteKindField = z.enum(SITE_KINDS, {
  error: () => `Kind must be one of: ${SITE_KINDS.join(", ")}.`,
});

// Latitude / longitude as coordinate-entry strings. min(1) gives the "required"
// message; the validateLatitude / validateLongitude mirror gives the range
// messages. The pin is REQUIRED (a Site is a place — DESIGN.md §Sites), so both
// are required on create.
const Latitude = z
  .string()
  .min(1, "Latitude is required.")
  .superRefine((value, ctx) => {
    const error = validateLatitude(value);
    if (error) {
      ctx.addIssue({ code: "custom", message: error });
    }
  });

const Longitude = z
  .string()
  .min(1, "Longitude is required.")
  .superRefine((value, ctx) => {
    const error = validateLongitude(value);
    if (error) {
      ctx.addIssue({ code: "custom", message: error });
    }
  });

// Optional free-text fields — mirror the API's Address / ContactName /
// ContactPhone bounds. Always a string at the DOM ("" = absent); the action
// omits an empty value on create and maps a cleared value to wire `null` on
// PATCH (the in-operator discipline). contactName / contactPhone are Tier-2 PII
// (ADR-0047 c6) — never rendered into a URL, never logged. Per the API note,
// contactPhone is deliberately NOT constrained by a phone regex (a site contact
// may be a landline, extension, or foreign number).
const Address = z.string().trim().max(512, "Address is too long.").optional();
const ContactName = z.string().trim().max(128, "Contact name is too long.").optional();
const ContactPhone = z.string().trim().max(32, "Contact phone is too long.").optional();

// Create form — required name/kind/latitude/longitude; optional address /
// contactName / contactPhone. Mirrors the API's CreateSiteSchema shape minus
// the number coercion: the form carries the coordinates as strings and the
// action converts them to JSON numbers.
export const CreateSiteFormSchema = z.object({
  name: Name,
  kind: SiteKindField,
  latitude: Latitude,
  longitude: Longitude,
  address: Address,
  contactName: ContactName,
  contactPhone: ContactPhone,
});

export type CreateSiteFormValues = z.infer<typeof CreateSiteFormSchema>;

// Update form — per-field optional (diff-PATCH semantics). The edit form's
// resolver uses the full CreateSiteFormSchema for immediate client-side
// required-field feedback against the visible shape; THIS schema validates the
// action's diff payload field-by-field (a partial diff may carry only `name` or
// only the coordinates). Mirror of the API's UpdateSiteSchema (which is
// CreateSiteSchema.partial()).
export const UpdateSiteFormSchema = z.object({
  name: Name.optional(),
  kind: SiteKindField.optional(),
  latitude: Latitude.optional(),
  longitude: Longitude.optional(),
  address: Address,
  contactName: ContactName,
  contactPhone: ContactPhone,
});

export type UpdateSiteFormValues = z.infer<typeof UpdateSiteFormSchema>;
