// Idempotent dispatch E2E fixture seeder (ADR-0047 W7/W8 + ADR-0035 D6).
//
// Creates the self-contained scenario the driver-app dispatch on-device E2E
// needs (docs/runbook/driver-app-dispatch-e2e.md):
//   - a DRIVER login (reusing create-user.ts's createUser — a WORKING better-auth
//     credential, not a bare Prisma insert) LINKED to a Driver row (Driver.userId,
//     ADR-0034 c4), so the own-record + own-vehicle predicates resolve;
//   - a vehicle;
//   - two Sites (pickup CRUSHER + drop-off DELIVERY_SITE, Kathmandu → Pokhara pins);
//   - a fresh OFFERED trip assigned to that driver + vehicle, carrying the order.
// So the operator can sign into the app as the driver, see the request, Accept,
// Start, tap progress, and read the D6 arrival indicator — the data setup
// dev-setup.md otherwise calls a manual admin-web + Prisma-Studio chore.
//
// Idempotent: fixed identifiers, upserted where a unique key exists; the OFFERED
// trip is created FRESH each run (a Trip has no natural key) and its id is logged,
// so re-running just adds another pending request. Requires an existing ADMIN
// (run seed-admin.ts first) for the dispatcher / createdById FK.
//
// Tier-1 discipline mirrors create-user.ts: the driver password is read from the
// validated env (CREATE_USER_PASSWORD), passed inline so it never lands in argv /
// `ps` / shell history, and is echoed nowhere.
//
//   Usage (LOCAL / dev DB only — never a production DB):
//     CREATE_USER_PASSWORD='<temp password>' \
//       pnpm --filter @fleetco/api exec tsx scripts/seed-dispatch-e2e.ts

import { fileURLToPath } from "node:url";

import {
  DriverStatus,
  LicenseClass,
  MaterialType,
  MeterType,
  PrismaClient,
  SiteKind,
  TripStatus,
  UserRole,
  VehicleKind,
  VehicleStatus,
} from "@prisma/client";

import { env } from "../src/config/env";
import { createUser } from "./create-user";

const DRIVER_EMAIL = "driver-e2e@fleetco.local";
const DRIVER_LICENSE = "E2E-DISPATCH-DRIVER";
const VEHICLE_REG = "BA-1-KHA-0001";
const PICKUP_NAME = "E2E Kalimati Crusher";
const DROPOFF_NAME = "E2E Pokhara Site";

// Find-or-create a Site by name (Site has no unique key, so re-runs must not
// duplicate). Inserts ONLY the native Float lat/lng — the geometry column is
// GENERATED ... STORED, so Prisma never writes it (the seedSite fixture rule).
async function findOrCreateSite(
  prisma: PrismaClient,
  params: {
    name: string;
    kind: SiteKind;
    latitude: number;
    longitude: number;
    createdById: string;
  },
): Promise<{ id: string }> {
  const existing = await prisma.site.findFirst({
    where: { name: params.name },
    select: { id: true },
  });
  if (existing) return existing;
  return prisma.site.create({ data: params, select: { id: true } });
}

async function main(): Promise<void> {
  if (!env.CREATE_USER_PASSWORD) {
    throw new Error(
      "CREATE_USER_PASSWORD must be set (the driver login's Tier-1 password; pass it inline so it is not persisted to .env).",
    );
  }

  const prisma = new PrismaClient();
  try {
    // The dispatcher / createdById FK — an existing ADMIN (seed-admin.ts first).
    const admin = await prisma.user.findFirst({
      where: { role: UserRole.ADMIN },
      select: { id: true },
    });
    if (!admin) {
      throw new Error(
        "No ADMIN user found. Run `pnpm --filter @fleetco/api exec tsx scripts/seed-admin.ts` first.",
      );
    }

    // 1. The driver LOGIN — reuses create-user.ts (better-auth signup + the
    //    privileged role write; idempotent on email), so this is a credential a
    //    driver can actually sign in with, not a bare Prisma row.
    const driverUser = await createUser(prisma, {
      email: DRIVER_EMAIL,
      password: env.CREATE_USER_PASSWORD,
      role: UserRole.DRIVER,
      name: "E2E Dispatch Driver",
    });

    // 2. The Driver row LINKED to that login (ADR-0034 c4). Upsert on the unique
    //    licenseNumber; set userId in BOTH arms so a re-run repairs the link.
    const driver = await prisma.driver.upsert({
      where: { licenseNumber: DRIVER_LICENSE },
      update: { userId: driverUser.id },
      create: {
        fullName: "E2E Dispatch Driver",
        licenseNumber: DRIVER_LICENSE,
        licenseClass: LicenseClass.HMV,
        phone: "+977-9800000001",
        hiredAt: new Date("2024-01-01"),
        licenseExpiresAt: new Date("2030-01-01"),
        status: DriverStatus.ACTIVE,
        userId: driverUser.id,
        createdById: admin.id,
      },
      select: { id: true },
    });

    // 3. The vehicle (upsert on the unique registrationNumber).
    const vehicle = await prisma.vehicle.upsert({
      where: { registrationNumber: VEHICLE_REG },
      update: {},
      create: {
        registrationNumber: VEHICLE_REG,
        kind: VehicleKind.TRUCK,
        make: "Tata",
        model: "LPK 2518",
        year: 2020,
        odometerStartKm: 0,
        odometerCurrentKm: 50_000,
        meterType: MeterType.ODOMETER_KM,
        acquiredAt: new Date("2020-06-01"),
        status: VehicleStatus.ACTIVE,
        createdById: admin.id,
      },
      select: { id: true },
    });

    // 4. The two Sites — pickup (crusher, Kathmandu) + drop-off (site, Pokhara).
    const pickup = await findOrCreateSite(prisma, {
      name: PICKUP_NAME,
      kind: SiteKind.CRUSHER,
      latitude: 27.7172,
      longitude: 85.324,
      createdById: admin.id,
    });
    const dropoff = await findOrCreateSite(prisma, {
      name: DROPOFF_NAME,
      kind: SiteKind.DELIVERY_SITE,
      latitude: 28.2096,
      longitude: 83.9856,
      createdById: admin.id,
    });

    // 5. A FRESH OFFERED trip carrying the order (written directly, like the
    //    fixtures — this bypasses the service transition; the order columns are
    //    exactly what the Requests card + order-detail view render).
    const trip = await prisma.trip.create({
      data: {
        vehicleId: vehicle.id,
        driverId: driver.id,
        createdById: admin.id,
        status: TripStatus.OFFERED,
        materialType: MaterialType.AGGREGATE,
        pickupSiteId: pickup.id,
        dropoffSiteId: dropoff.id,
        consigneeName: "Ram Bahadur",
        consigneePhone: "+977-9812345678",
        expectedLoadCount: 3,
        specialInstructions: "Call on arrival; gate code 4821.",
        docketNumber: "E2E-DOCKET-001",
        offeredAt: new Date(),
      },
      select: { id: true },
    });

    console.log("Dispatch E2E fixtures ready:");
    console.log(`  driver login : ${DRIVER_EMAIL} (role DRIVER, id=${driverUser.id})`);
    console.log(`  driver row   : id=${driver.id} (licenseNumber ${DRIVER_LICENSE})`);
    console.log(`  vehicle      : ${VEHICLE_REG} (id=${vehicle.id})`);
    console.log(`  pickup site  : ${PICKUP_NAME} (id=${pickup.id})`);
    console.log(`  dropoff site : ${DROPOFF_NAME} (id=${dropoff.id})`);
    console.log(`  OFFERED trip : id=${trip.id}`);
    console.log("");
    console.log(
      `Sign into the driver app as ${DRIVER_EMAIL} — the Requests tab shows the OFFERED trip.`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

// Run only when executed directly (not if imported), mirroring create-user.ts.
const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
