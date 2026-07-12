import { z } from "zod";

/**
 * The `POST /api/v1/routing/route-preview` request body (ADR-0047 c9). Two
 * points, coordinate-bounded, `.strict()` so an unknown key 400s — the trips
 * schemas' convention. Coordinates ride in the POST BODY, never a URL query
 * string (the PII-in-URL anti-pattern the dispatch surface avoids throughout;
 * site coordinates are Tier-5 location, not query-string material).
 */

const Latitude = z
  .number()
  .min(-90, "lat must be between -90 and 90.")
  .max(90, "lat must be between -90 and 90.");
const Longitude = z
  .number()
  .min(-180, "lng must be between -180 and 180.")
  .max(180, "lng must be between -180 and 180.");

const Point = z.object({ lat: Latitude, lng: Longitude }).strict();

export const RoutePreviewSchema = z
  .object({
    origin: Point,
    destination: Point,
  })
  .strict();

export type RoutePreviewInput = z.infer<typeof RoutePreviewSchema>;
