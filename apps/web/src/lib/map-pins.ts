import L from "leaflet";

// The shared teardrop pin divIcon for the Leaflet map surfaces — extracted
// verbatim from trips/[id]/trip-map.tsx (ADR-0047 W6) so the /map
// active-trips layer (ADR-0048) renders the SAME pin, one implementation.
//
// This module imports Leaflet, which touches `window` at module load — it
// must only ever be imported by client-only islands (next/dynamic
// { ssr: false }), exactly like the components that consume it.

/**
 * A teardrop pin divIcon in a given CSS-var color. var() DOES resolve inside
 * the divIcon HTML (custom properties cascade into the Leaflet marker pane),
 * unlike pathOptions — so this uses no Tailwind class token and the
 * design-token consumption sweep stays green. The tip sits on the coordinate
 * (iconAnchor).
 */
export function pinDivIcon(colorVar: string, fallback: string): L.DivIcon {
  return L.divIcon({
    className: "",
    html:
      `<span style="color: var(${colorVar}, ${fallback}); ` +
      `filter: drop-shadow(0 1px 1px rgba(0,0,0,0.35)); display: block; line-height: 0;">` +
      `<svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 24 24" ` +
      `fill="currentColor" stroke="#ffffff" stroke-width="1.5" stroke-linecap="round" ` +
      `stroke-linejoin="round">` +
      `<path d="M12 21s7-6.13 7-11a7 7 0 1 0-14 0c0 4.87 7 11 7 11z"/>` +
      `<circle cx="12" cy="10" r="2.5" fill="#ffffff" stroke="none"/></svg></span>`,
    iconSize: [28, 28],
    iconAnchor: [14, 28],
  });
}
