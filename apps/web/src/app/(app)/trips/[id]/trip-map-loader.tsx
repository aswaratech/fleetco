"use client";

import dynamic from "next/dynamic";

import type { TripMapProps } from "./trip-map";

// Client loader for the read-only trip-detail tracking map. The detail page
// (page.tsx) is a Server Component, and next/dynamic({ ssr: false }) is only
// allowed inside a Client Component (Leaflet touches `window` at module load),
// so this thin "use client" wrapper does the dynamic import and the server page
// renders <TripMapView>. Mirror of the sites detail-map loader (ADR-0047 W5).
const TripMap = dynamic(() => import("./trip-map").then((m) => m.TripMap), {
  ssr: false,
  loading: () => (
    <div className="border-border-subtle bg-surface-canvas text-text-muted flex h-72 w-full items-center justify-center rounded-md border text-sm">
      Loading map…
    </div>
  ),
});

export function TripMapView(props: TripMapProps): React.ReactElement {
  return <TripMap {...props} />;
}
