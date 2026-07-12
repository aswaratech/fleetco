import { randomUUID } from "node:crypto";
import {
  type PrismaClient,
  type Trip,
  type Vehicle,
  type Driver,
  type MaterialType,
  MeterType,
  TripStatus,
  type UserRole,
  VehicleKind,
  VehicleStatus,
  DriverStatus,
  LicenseClass,
} from "@prisma/client";

// Test fixtures for the Trip slice. Trip's FKs (vehicleId, driverId,
// createdById) make every test require at least one User, one Vehicle,
// and one Driver to be in place before it can create a trip. This
// helper centralizes the seed wiring so the per-file beforeEach blocks
// stay small and the test bodies focus on what they are actually
// asserting.
//
// Kept under apps/api/test/fixtures/ — same convention the prior
// Drivers and Vehicles tests would have grown into once Trip arrived.
// Promoting these helpers to a shared package is deferred until a
// second test consumer needs them (e.g., the iter-9 write-path tests).

/**
 * Create a user row suitable for a Trip's createdById FK. Returns the
 * generated id. The email is unique per call so tests can run in
 * parallel against a shared row by happenstance without colliding on
 * `user_email_key`.
 */
export async function seedUser(prisma: PrismaClient, role?: UserRole): Promise<string> {
  const id = `user_${randomUUID()}`;
  await prisma.user.create({
    data: {
      id,
      email: `admin-${id}@fleetco.test`,
      name: "Test Admin",
      // Default role (OFFICE_STAFF) unless a test needs a DRIVER / ADMIN user;
      // the D2 own-record tests seed a DRIVER user linked to a Driver row.
      ...(role ? { role } : {}),
    },
  });
  return id;
}

/**
 * Create a Vehicle row suitable for a Trip's vehicleId FK. The
 * registration number is unique per call (vehicle's unique constraint
 * on registrationNumber would otherwise collide between tests). All
 * other fields take sensible Phase-1 defaults; the caller can override
 * via the `overrides` parameter when a specific test needs particular
 * values (e.g. a STORED vehicle that should not be schedulable).
 */
export async function seedVehicle(
  prisma: PrismaClient,
  createdById: string,
  overrides: Partial<Omit<Vehicle, "id" | "createdAt" | "updatedAt" | "createdById">> = {},
): Promise<Vehicle> {
  return prisma.vehicle.create({
    data: {
      registrationNumber: overrides.registrationNumber ?? `BA-1-PA-${randomUUID().slice(0, 4)}`,
      kind: overrides.kind ?? VehicleKind.TRUCK,
      make: overrides.make ?? "Tata",
      model: overrides.model ?? "LPK 2518",
      year: overrides.year ?? 2018,
      odometerStartKm: overrides.odometerStartKm ?? 0,
      odometerCurrentKm: overrides.odometerCurrentKm ?? 80000,
      // Engine-hours metering (ADR-0036). Default ODOMETER_KM + null hours
      // so the existing trip/odometer tests seed km-only vehicles unchanged;
      // the engine-hours tests override meterType + engineHoursCurrent.
      meterType: overrides.meterType ?? MeterType.ODOMETER_KM,
      engineHoursStart: overrides.engineHoursStart ?? null,
      engineHoursCurrent: overrides.engineHoursCurrent ?? null,
      acquiredAt: overrides.acquiredAt ?? new Date("2018-06-01"),
      retiredAt: overrides.retiredAt ?? null,
      status: overrides.status ?? VehicleStatus.ACTIVE,
      // Nepal compliance metadata (iter 14). All nullable, defaulting to null so
      // existing km-only seeds are unchanged; the `overrides` type already
      // promised these fields, so wiring them here lets a test seed an expiring /
      // expired document (e.g. the ADR-0038 reminder-scan tests) without a
      // follow-up prisma.update.
      bluebookNumber: overrides.bluebookNumber ?? null,
      bluebookExpiresAt: overrides.bluebookExpiresAt ?? null,
      insurer: overrides.insurer ?? null,
      insurancePolicyNumber: overrides.insurancePolicyNumber ?? null,
      insuranceType: overrides.insuranceType ?? null,
      insuranceExpiresAt: overrides.insuranceExpiresAt ?? null,
      routePermitNumber: overrides.routePermitNumber ?? null,
      routePermitExpiresAt: overrides.routePermitExpiresAt ?? null,
      createdById,
    },
  });
}

/**
 * Create a Driver row suitable for a Trip's driverId FK. The license
 * number is unique per call (the driver's unique constraint on
 * licenseNumber would otherwise collide). Defaults match a Phase-1
 * "active heavy-vehicle driver" so the common case is a one-liner;
 * overrides are accepted for tests that need a TERMINATED driver or a
 * specific license class.
 */
export async function seedDriver(
  prisma: PrismaClient,
  createdById: string,
  overrides: Partial<Omit<Driver, "id" | "createdAt" | "updatedAt" | "createdById">> = {},
): Promise<Driver> {
  return prisma.driver.create({
    data: {
      fullName: overrides.fullName ?? "Ram Bahadur Shrestha",
      licenseNumber: overrides.licenseNumber ?? `LIC-${randomUUID().slice(0, 8)}`,
      licenseClass: overrides.licenseClass ?? LicenseClass.HMV,
      phone: overrides.phone ?? "+977-9800000000",
      dateOfBirth: overrides.dateOfBirth ?? null,
      hiredAt: overrides.hiredAt ?? new Date("2022-04-01"),
      licenseExpiresAt: overrides.licenseExpiresAt ?? new Date("2028-04-01"),
      status: overrides.status ?? DriverStatus.ACTIVE,
      terminatedAt: overrides.terminatedAt ?? null,
      // The User↔Driver login link (ADR-0034 c4). Null by default; the D2
      // own-record tests pass a DRIVER user's id here to link the two so a
      // DRIVER actor resolves to this Driver row.
      userId: overrides.userId ?? null,
      createdById,
    },
  });
}

/**
 * Create a Trip row with sensible defaults. Trip has three FKs
 * (vehicleId, driverId, createdById) which the caller must satisfy by
 * passing valid ids; the helper does NOT seed them automatically
 * because tests usually need to refer to those parent rows by id
 * themselves (e.g., to assert that a list-by-vehicleId filter
 * returned the right window).
 *
 * Defaults reflect a "freshly planned trip" — status PLANNED, no
 * startedAt / endedAt / odometer fields. The iter-9 write path will
 * exercise the COMPLETED transition; this fixture stays read-path-
 * focused so the iter-8 tests do not accidentally rely on iter-9
 * semantics.
 */
export interface SeedTripParams {
  vehicleId: string;
  driverId: string;
  createdById: string;
  status?: TripStatus;
  startedAt?: Date | null;
  endedAt?: Date | null;
  startOdometerKm?: number | null;
  endOdometerKm?: number | null;
  // Engine-hours readings (ADR-0036), integer tenths-of-an-hour. Captured
  // only for hour-metered vehicles; null for km-only trips (the default).
  startEngineHours?: number | null;
  endEngineHours?: number | null;
  notes?: string | null;
  // Dispatch order + milestones (ADR-0047 W4). All nullable, defaulting to
  // null so the ~200 pre-dispatch trip seeds are unchanged; the W4 dispatch
  // tests override them to seed an OFFERED trip carrying an order, or a trip
  // with milestone timestamps set. pickupSiteId / dropoffSiteId reference a
  // Site the test seeds first (via seedSite).
  materialType?: MaterialType | null;
  materialNote?: string | null;
  pickupSiteId?: string | null;
  dropoffSiteId?: string | null;
  consigneeName?: string | null;
  consigneePhone?: string | null;
  expectedLoadCount?: number | null;
  specialInstructions?: string | null;
  docketNumber?: string | null;
  offeredAt?: Date | null;
  acceptedAt?: Date | null;
  arrivedPickupAt?: Date | null;
  loadedAt?: Date | null;
  arrivedDropoffAt?: Date | null;
  deliveredAt?: Date | null;
}

export async function seedTrip(prisma: PrismaClient, params: SeedTripParams): Promise<Trip> {
  return prisma.trip.create({
    data: {
      vehicleId: params.vehicleId,
      driverId: params.driverId,
      createdById: params.createdById,
      status: params.status ?? TripStatus.PLANNED,
      startedAt: params.startedAt ?? null,
      endedAt: params.endedAt ?? null,
      startOdometerKm: params.startOdometerKm ?? null,
      endOdometerKm: params.endOdometerKm ?? null,
      startEngineHours: params.startEngineHours ?? null,
      endEngineHours: params.endEngineHours ?? null,
      notes: params.notes ?? null,
      // Dispatch order + milestones (ADR-0047 W4) — pass-through, null default.
      materialType: params.materialType ?? null,
      materialNote: params.materialNote ?? null,
      pickupSiteId: params.pickupSiteId ?? null,
      dropoffSiteId: params.dropoffSiteId ?? null,
      consigneeName: params.consigneeName ?? null,
      consigneePhone: params.consigneePhone ?? null,
      expectedLoadCount: params.expectedLoadCount ?? null,
      specialInstructions: params.specialInstructions ?? null,
      docketNumber: params.docketNumber ?? null,
      offeredAt: params.offeredAt ?? null,
      acceptedAt: params.acceptedAt ?? null,
      arrivedPickupAt: params.arrivedPickupAt ?? null,
      loadedAt: params.loadedAt ?? null,
      arrivedDropoffAt: params.arrivedDropoffAt ?? null,
      deliveredAt: params.deliveredAt ?? null,
    },
  });
}
