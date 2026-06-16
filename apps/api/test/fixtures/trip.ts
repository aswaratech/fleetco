import { randomUUID } from "node:crypto";
import {
  type PrismaClient,
  type Trip,
  type Vehicle,
  type Driver,
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
      acquiredAt: overrides.acquiredAt ?? new Date("2018-06-01"),
      retiredAt: overrides.retiredAt ?? null,
      status: overrides.status ?? VehicleStatus.ACTIVE,
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
  notes?: string | null;
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
      notes: params.notes ?? null,
    },
  });
}
