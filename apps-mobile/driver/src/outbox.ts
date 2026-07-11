// D5 offline outbox — the PURE half (ADR-0035 c2). The policy layer over the
// encrypted on-device buffer: row↔wire mapping and the two bounds that keep
// the outbox from growing without limit. The native shell (SQLCipher database,
// key management, actual SQL) is src/outbox-sqlite.ts, which tests never
// import — the ADR-0033 c4 binary-free gate stays native-free.

import type { WirePing } from "./gps";

// A buffered fix as stored: exactly the wire shape plus the row id the drain
// uses to delete-on-delivered. The SELECT in outbox-sqlite.ts aliases its
// snake_case columns onto these names, so a row IS a WirePing plus `id`.
export interface OutboxRow extends WirePing {
  id: number;
}

// PROVISIONAL outbox bounds (the owner-level-number pattern — ADR-0035
// ratifies the outbox mechanics, the implementing slice pins the numbers and
// tunes them with pilot data):
//   - OUTBOX_MAX_AGE_H: a fix older than this is operationally dead — the
//     retention prune (ADR-0031) would age it out server-side soon after
//     arrival anyway, so carrying it across more than two days of outage
//     buys nothing. Age-out happens on capture time (the fix timestamp).
//   - OUTBOX_MAX_ROWS: a hard cap so a never-draining outbox (server gone,
//     credentials revoked) cannot grow unbounded. At the D4 capture cadence
//     (~4 fixes/min) this is roughly 3.5 driving days of buffer. Overflow
//     drops the OLDEST rows first: on reconnect the freshest trail is the
//     one worth having.
export const OUTBOX_MAX_AGE_H = 48;
export const OUTBOX_MAX_ROWS = 20_000;

// The age-out cutoff as an ISO string. Both sides of the comparison are
// produced by Date.prototype.toISOString (fixed format, UTC, millisecond
// precision), so the SQL `timestamp < cutoff` TEXT comparison is
// chronologically correct — lexicographic order IS time order for that format.
export function agePruneCutoffIso(nowMs: number): string {
  return new Date(nowMs - OUTBOX_MAX_AGE_H * 3_600_000).toISOString();
}

// How many oldest rows the row-cap prune must delete (0 at or under the cap).
export function overCapDeleteCount(rowCount: number): number {
  return Math.max(0, rowCount - OUTBOX_MAX_ROWS);
}

// Strip rows back to the wire shape for the drain POST. The server schema is
// `.strict()` — an extra key (like `id`) would 400 the whole batch — so this
// rebuilds the ping key-for-key instead of spreading the row.
export function wirePingsFromRows(rows: readonly OutboxRow[]): WirePing[] {
  return rows.map((row) => ({
    vehicleId: row.vehicleId,
    tripId: row.tripId,
    latitude: row.latitude,
    longitude: row.longitude,
    altitude: row.altitude,
    speed: row.speed,
    heading: row.heading,
    timestamp: row.timestamp,
  }));
}
