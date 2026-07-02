"use client";

import dynamic from "next/dynamic";

import type { LiveMapProps } from "./live-map";

// Client-side loader for the Leaflet island. Leaflet references `window` at
// module load, so the island must never render on the server — and in the
// App Router `next/dynamic(..., { ssr: false })` is only legal inside a
// client component, hence this thin wrapper between the server page and the
// island (the same split the geofence forms use). The fixed-height
// placeholder holds the page layout while the chunk loads.
const LiveMap = dynamic(() => import("./live-map").then((m) => m.LiveMap), {
  ssr: false,
  loading: () => (
    <div className="border-border-subtle bg-surface-raised text-text-muted flex min-h-[70vh] w-full items-center justify-center rounded border text-sm shadow-sm">
      Loading map…
    </div>
  ),
});

export function LiveMapLoader(props: LiveMapProps): React.ReactElement {
  return <LiveMap {...props} />;
}
