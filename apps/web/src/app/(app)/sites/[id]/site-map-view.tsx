"use client";

import dynamic from "next/dynamic";

// Client loader for the read-only Site detail map. The detail page (page.tsx) is
// a Server Component, and next/dynamic({ ssr: false }) is only allowed inside a
// Client Component (Leaflet touches `window` at module load), so this thin "use
// client" wrapper does the dynamic import and the server page renders
// <SiteDetailMap>. Mirror of the live-map loader pattern. ADR-0047 W5.
const SiteMapView = dynamic(() => import("../site-map-editor").then((m) => m.SiteMapView), {
  ssr: false,
  loading: () => (
    <div className="border-border-subtle bg-surface-canvas text-text-muted flex h-72 w-full items-center justify-center rounded-md border text-sm">
      Loading map…
    </div>
  ),
});

interface SiteDetailMapProps {
  latitude: number;
  longitude: number;
  name: string;
}

export function SiteDetailMap({
  latitude,
  longitude,
  name,
}: SiteDetailMapProps): React.ReactElement {
  return <SiteMapView latitude={latitude} longitude={longitude} name={name} />;
}
