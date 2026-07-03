import { NotFoundException } from "@nestjs/common";
import { DriverStatus, LicenseClass } from "@prisma/client";
import { z } from "zod";

import { type DriversService } from "../../drivers/drivers.service";
import {
  CreateDriverSchema,
  ListDriversQuerySchema,
  type DriverSortColumn,
} from "../../drivers/drivers.schemas";
import { toQueryShape } from "./query-shape";
import { GetByIdArgs, type ToolDefinition } from "./tool.types";

// Drivers tools (ADR-0043 c3: A4 reads, A7 create). Driver rows carry Tier-2
// PII — the registry's redaction pass strips dateOfBirth and masks
// licenseNumber to its last 4 before any RESULT enters model context (c6);
// fullName and phone pass as operational contact data (PO-accepted). On the
// create path the model may SUPPLY licenseNumber/dateOfBirth — c6c's honest
// limit: what the user types in chat reaches the provider verbatim anyway;
// the stored row is the system of record and the returned result is redacted
// like any other.

const DRIVER_SORT = [
  "fullName",
  "hiredAt",
  "licenseExpiresAt",
  "createdAt",
] as const satisfies readonly DriverSortColumn[];

const ListDriversArgs = z
  .object({
    status: z.array(z.enum(DriverStatus)).optional(),
    licenseClass: z.array(z.enum(LicenseClass)).optional(),
    sortBy: z.enum(DRIVER_SORT).optional(),
    sortDir: z.enum(["asc", "desc"]).optional(),
    skip: z.number().int().min(0).optional(),
    take: z.number().int().min(1).max(200).optional(),
  })
  .strict();

// Mirrors CreateDriverSchema field-for-field. The Nepal phone regex is NOT
// duplicated here — wrappers teach shape, the module schema owns content
// rules and re-validates at execute (a bad number surfaces as the house 400
// with the module's own guidance message).
const CreateDriverArgs = z
  .object({
    fullName: z.string().trim().min(1).max(128),
    licenseNumber: z.string().trim().min(1).max(64),
    licenseClass: z.enum(LicenseClass),
    phone: z.string().trim().min(1),
    dateOfBirth: z.iso.date().optional(),
    hiredAt: z.iso.date(),
    licenseExpiresAt: z.iso.date(),
    status: z.enum(DriverStatus).optional(),
  })
  .strict();

export function buildDriversTools(drivers: DriversService): ToolDefinition[] {
  return [
    {
      name: "list_drivers",
      description:
        "List drivers with optional status/licenseClass filters, sorting, and " +
        "pagination (take ≤ 200). License numbers come back masked to their last " +
        "4 characters; dates are ISO.",
      capabilities: ["drivers:*"],
      riskTier: "read",
      argsSchema: ListDriversArgs,
      async execute(args) {
        const query = ListDriversQuerySchema.parse(toQueryShape(ListDriversArgs.parse(args)));
        return drivers.list(query);
      },
    },
    {
      name: "get_driver",
      description:
        "Fetch one driver by id: name, phone, license class, masked license number, " +
        "hire date, license expiry (ISO dates).",
      capabilities: ["drivers:*"],
      riskTier: "read",
      argsSchema: GetByIdArgs,
      async execute(args) {
        const { id } = GetByIdArgs.parse(args);
        const driver = await drivers.findById(id);
        if (driver === null) {
          throw new NotFoundException(`Driver ${id} not found.`);
        }
        return driver;
      },
    },
    {
      name: "create_driver",
      description:
        "Register a new driver. Required: fullName, licenseNumber (unique — a " +
        "duplicate fails with a conflict), licenseClass, phone (a Nepal number, " +
        "e.g. +977-98…), hiredAt and licenseExpiresAt (ISO YYYY-MM-DD). Optional: " +
        "dateOfBirth (ISO), status. The result echoes the driver with the license " +
        "number masked to its last 4. The write happens immediately and exactly " +
        "once; the result includes the new driver's id.",
      capabilities: ["drivers:*"],
      riskTier: "reversible-write",
      resultEntityType: "Driver",
      argsSchema: CreateDriverArgs,
      async execute(args, actor) {
        const input = CreateDriverSchema.parse(CreateDriverArgs.parse(args));
        return drivers.create(input, actor.userId);
      },
    },
  ];
}
