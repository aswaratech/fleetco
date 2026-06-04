import { z } from "zod";

// Web-side form schemas + display helpers + WKT round-trip for the
// Geofences slice (ADR-0030 G3). Mirrors the API's authoritative schemas
// (apps/api/src/modules/geofences/geofences.schemas.ts) and the shared
// WKT builder (apps/api/src/common/wkt.ts) at the field level. The API is
// authoritative; these give the operator immediate inline feedback before
// a round-trip.
//
// Duplication-budget rationale matches customers-schema.ts / jobs-schema.ts
// / fuel-logs-schema.ts: a shared workspace package is deferred; the API
// rejects anything sent incorrectly, so client drift is a UX cost, not a
// correctness one. The shared package becomes worthwhile when the driver
// app (Phase 2) needs these shapes.
//
// THE BOUNDARY REPRESENTATION (ADR-0030 c1): the API's `boundary` write
// field is the `lon,lat;lon,lat;…` vertex string (NOT the stored
// `boundaryWkt`). The G3 coordinate-entry form collects exactly that
// string and the action sends it verbatim; the API's shared PolygonParam
// builds the canonical `POLYGON((…))` WKT and the database derives the
// geometry. The G4 map editor will serialize a drawn ring to the SAME
// `lon,lat;…` string, so the storage/representation contract is unchanged
// — only the input surface grows. The stored/read `boundaryWkt` is the
// closed `POLYGON((…))` WKT; `wktToVertexInput` converts it back to the
// `lon,lat;…` representation for the edit form's pre-fill.

// GeofenceType — mirrors the Prisma GeofenceType enum + the API's
// GEOFENCE_TYPES list. Single source of truth for the web side; the
// `Geofence` row type (app/geofences/types.ts) imports GeofenceTypeName
// from here so a new type is added in one place. Order matches the Prisma
// enum; it has no runtime significance.
export const GEOFENCE_TYPES = ["DEPOT", "CUSTOMER_SITE", "ROUTE_CORRIDOR"] as const;
export type GeofenceTypeName = (typeof GEOFENCE_TYPES)[number];

// Display options for the <select>s and the label map. Single source of
// truth in the array; the label map is derived so a new type is added in
// one place (mirror of CUSTOMER_STATUS_OPTIONS / JOB_STATUS_OPTIONS).
export const GEOFENCE_TYPE_OPTIONS = [
  { value: "DEPOT", label: "Depot" },
  { value: "CUSTOMER_SITE", label: "Customer site" },
  { value: "ROUTE_CORRIDOR", label: "Route corridor" },
] as const;

export const GEOFENCE_TYPE_LABELS: Record<string, string> = Object.fromEntries(
  GEOFENCE_TYPE_OPTIONS.map(({ value, label }) => [value, label]),
);

// Vertex-count bounds — mirror apps/api/src/common/wkt.ts
// POLYGON_MIN_VERTICES / POLYGON_MAX_VERTICES. A linear ring needs at
// least 3 distinct vertices (a triangle); 1000 is the generous ceiling
// for a hand-drawn admin boundary. When the API bounds change, this file
// changes in the same commit.
export const POLYGON_MIN_VERTICES = 3;
export const POLYGON_MAX_VERTICES = 1000;

/**
 * Validate a `lon,lat;lon,lat;…` coordinate-entry string the same way the
 * API's shared PolygonParam (apps/api/src/common/wkt.ts) does, so the
 * operator gets the same rejection inline before the round-trip. Returns
 * an error message, or null when the string is a valid ring.
 *
 * Mirrors PolygonParam exactly: 3–1000 `;`-separated vertices, each
 * exactly `lon,lat`, lon ∈ [-180, 180], lat ∈ [-90, 90], both finite
 * (WGS84). The ring need not be pre-closed — the API auto-closes it, so a
 * 3-vertex triangle is valid. The X,Y order is load-bearing (WKT is
 * `lon lat`); a swapped pair puts latitude where longitude belongs and
 * `ST_Contains` misclassifies. The API remains authoritative; this is for
 * immediate feedback only.
 */
export function validateVertexInput(raw: string): string | null {
  const vertexStrs = raw
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (vertexStrs.length < POLYGON_MIN_VERTICES) {
    return `Boundary needs at least ${POLYGON_MIN_VERTICES} vertices as "lon,lat;lon,lat;lon,lat".`;
  }
  if (vertexStrs.length > POLYGON_MAX_VERTICES) {
    return `Boundary must have at most ${POLYGON_MAX_VERTICES} vertices.`;
  }
  for (const vs of vertexStrs) {
    const parts = vs.split(",");
    if (parts.length !== 2) {
      return `Boundary vertex "${vs}" must be "lon,lat".`;
    }
    // Number() tolerates surrounding whitespace, matching the API parser;
    // the displayed value is trimmed for readability.
    const lon = Number(parts[0]);
    const lat = Number(parts[1]);
    if (!Number.isFinite(lon) || lon < -180 || lon > 180) {
      return `Boundary vertex longitude "${parts[0].trim()}" must be a number between -180 and 180.`;
    }
    if (!Number.isFinite(lat) || lat < -90 || lat > 90) {
      return `Boundary vertex latitude "${parts[1].trim()}" must be a number between -90 and 90.`;
    }
  }
  return null;
}

/**
 * Convert a stored `boundaryWkt` (`POLYGON((lon lat, lon lat, …))`) back
 * into the `lon,lat;lon,lat;…` coordinate-entry representation, for the
 * edit form's pre-fill. The API stores a single-ring polygon (no holes),
 * so the inner coordinate list is parsed directly. Returns "" when the
 * WKT is not a parseable single-ring POLYGON — a defensive fallback so a
 * future storage-format change renders an empty box (which the operator
 * can re-enter) rather than crashing the edit form.
 *
 * The stored ring is closed (first vertex repeated last); this helper
 * preserves every vertex verbatim, and the API's PolygonParam treats an
 * already-closed ring idempotently (it only appends a closing vertex when
 * first ≠ last), so the value round-trips without drift.
 */
export function wktToVertexInput(boundaryWkt: string): string {
  // [^()]* captures the single ring's coordinate list — a Geofence is a
  // hole-less polygon, so there are no inner parens to span.
  const match = /^\s*POLYGON\s*\(\s*\(([^()]*)\)\s*\)\s*$/i.exec(boundaryWkt);
  if (!match) return "";
  const inner = match[1].trim();
  if (inner.length === 0) return "";
  const vertices: string[] = [];
  for (const pair of inner.split(",")) {
    const coords = pair.trim().split(/\s+/);
    if (coords.length !== 2) return "";
    const [lon, lat] = coords;
    if (lon.length === 0 || lat.length === 0) return "";
    vertices.push(`${lon},${lat}`);
  }
  return vertices.join(";");
}

// ---------------------------------------------------------------------
// Form schemas.
// ---------------------------------------------------------------------

// Name bounds mirror the API's Name (trim, 1..256). 256 is loose to
// accommodate Nepali transliterated site names.
const Name = z.string().trim().min(1, "Name is required.").max(256, "Name is too long.");

// Boundary: the lon,lat;… coordinate-entry string. min(1) gives the
// "required" message; the PolygonParam mirror (validateVertexInput) gives
// the structured bounds messages.
const Boundary = z
  .string()
  .min(1, "Boundary is required.")
  .superRefine((value, ctx) => {
    const error = validateVertexInput(value);
    if (error) {
      ctx.addIssue({ code: "custom", message: error });
    }
  });

const GeofenceTypeField = z.enum(GEOFENCE_TYPES, {
  error: () => `Type must be one of: ${GEOFENCE_TYPES.join(", ")}.`,
});

// The type/ownership cross-field rule (ADR-0030 c4), mirrored client-side
// so the operator sees the contradiction immediately. CUSTOMER_SITE
// requires a customer; DEPOT / ROUTE_CORRIDOR forbid one. Pinned to the
// customerId path so the picker (not the whole form) shows the message.
// The API re-validates against the merged shape and remains authoritative.
function refineOwnership(
  value: { type: GeofenceTypeName; customerId?: string },
  ctx: z.RefinementCtx,
): void {
  const hasCustomer = typeof value.customerId === "string" && value.customerId.length > 0;
  if (value.type === "CUSTOMER_SITE" && !hasCustomer) {
    ctx.addIssue({
      code: "custom",
      message: "A customer-site geofence requires a customer.",
      path: ["customerId"],
    });
  }
  if (value.type !== "CUSTOMER_SITE" && hasCustomer) {
    ctx.addIssue({
      code: "custom",
      message: "Only a customer-site geofence has an owning customer.",
      path: ["customerId"],
    });
  }
}

// Create form — required name/type/boundary; customerId required only for
// CUSTOMER_SITE (the superRefine). Mirrors the API's CreateGeofenceSchema
// shape minus the WKT transform: the action sends the raw `lon,lat;…`
// string and the API builds the canonical WKT.
export const CreateGeofenceFormSchema = z
  .object({
    name: Name,
    type: GeofenceTypeField,
    boundary: Boundary,
    // "" from the picker means "no customer". Always a string at the DOM.
    customerId: z.string().optional(),
  })
  .superRefine((value, ctx) => refineOwnership(value, ctx));

export type CreateGeofenceFormValues = z.infer<typeof CreateGeofenceFormSchema>;

// Update form — per-field optional (diff-PATCH semantics). No cross-field
// ownership refine here: a partial diff may carry only `type` or only
// `customerId`, so the rule is decided against the merged shape by the API
// service (mirror of the API's UpdateGeofenceSchema, which also omits the
// superRefine). The edit form's resolver uses the full
// CreateGeofenceFormSchema for immediate client-side ownership feedback;
// this schema validates the action's diff payload field-by-field.
export const UpdateGeofenceFormSchema = z.object({
  name: Name.optional(),
  type: GeofenceTypeField.optional(),
  boundary: Boundary.optional(),
  // "" → the action maps to null (clear the owner). A cuid sets it.
  customerId: z.string().optional(),
});

export type UpdateGeofenceFormValues = z.infer<typeof UpdateGeofenceFormSchema>;
