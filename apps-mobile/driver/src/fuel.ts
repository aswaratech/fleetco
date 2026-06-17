// Driver-app fuel-log domain types, unit converters, and the pure POST-body
// builder (ADR-0034 D3). Like trips.ts, this standalone app cannot import the
// API's types or the web's converters, so the slim shapes a driver writes are
// declared here. The wire stores volume as integer milliliters and price as
// integer paisa (CLAUDE.md §"Money & units"); the driver types liters/rupees as
// decimals, and these helpers convert with the SAME Math.round (half-up) rule the
// web form and the API use — so the total a driver previews matches the persisted
// totalCostPaisa bit-for-bit. The builder takes `nowIso` as a parameter (not
// new Date()) so it stays pure and the unit tests are deterministic — the screen
// supplies new Date().toISOString().
//
// Standalone copies of the web converters (kept in sync, not imported):
//   - litersToMl           ← apps/web/src/lib/fuel-logs-schema.ts
//   - rupeesToPaisa        ← apps/web/src/lib/money.ts
//   - previewTotalCostPaisa ← apps/web/src/lib/fuel-logs-schema.ts

// The POST /api/v1/fuel-logs body a driver sends. A driver fuel log MUST carry a
// tripId that is one of their own trips (ADR-0034 D2 own-record scope), and the
// vehicleId must match that trip's vehicle — the screen derives vehicleId FROM
// the selected trip so the two are always consistent. `totalCostPaisa` and
// `createdById` are derived server-side; the schema is .strict(), so they are
// never sent. `odometerReadingKm` is optional (omitted when not entered).
export interface FuelLogPayload {
  vehicleId: string;
  tripId: string;
  date: string;
  litersMl: number;
  pricePerLiterPaisa: number;
  odometerReadingKm?: number;
}

// Liters (decimal) → integer milliliters. Math.round (half-up) matches the web
// form and the API, so a fourth-decimal sub-milliliter rounds the same everywhere.
export function litersToMl(liters: number): number {
  return Math.round(liters * 1000);
}

// Rupees (decimal) → integer paisa (1 NPR = 100 paisa). Math.round (half-up)
// matches the web's money.ts converter and the API.
export function rupeesToPaisa(rupees: number): number {
  return Math.round(rupees * 100);
}

// The total-cost preview the fuel screen renders before submit, in integer paisa.
// Algebraically identical to the API's deriveTotalCostPaisa
// (Math.round(litersMl * pricePerLiterPaisa / 1000)) computed straight from the
// decimal inputs, so the preview equals the persisted totalCostPaisa. Returns
// null when either input is missing or not finite (the screen renders an em-dash).
export function previewTotalCostPaisa(
  liters: number | null,
  pricePerLiter: number | null,
): number | null {
  if (liters === null || pricePerLiter === null) return null;
  if (!Number.isFinite(liters) || !Number.isFinite(pricePerLiter)) return null;
  return Math.round(liters * pricePerLiter * 100);
}

// Build the POST body from the driver's selected trip + decimal inputs. Converts
// liters/rupees to the integer mL/paisa the wire expects and stamps `date` with
// the supplied `nowIso`. `odometerReadingKm` is included only when a reading was
// entered (undefined → key omitted, never sent as null).
export function fuelLogPayload(
  input: {
    vehicleId: string;
    tripId: string;
    liters: number;
    pricePerLiter: number;
    odometerKm?: number;
  },
  nowIso: string,
): FuelLogPayload {
  const payload: FuelLogPayload = {
    vehicleId: input.vehicleId,
    tripId: input.tripId,
    date: nowIso,
    litersMl: litersToMl(input.liters),
    pricePerLiterPaisa: rupeesToPaisa(input.pricePerLiter),
  };
  if (input.odometerKm !== undefined) {
    payload.odometerReadingKm = input.odometerKm;
  }
  return payload;
}
