import { NotFoundException } from "@nestjs/common";
import { DriverStatus, LicenseClass } from "@prisma/client";
import { z } from "zod";

import { type DriversService } from "../../drivers/drivers.service";
import { ListDriversQuerySchema, type DriverSortColumn } from "../../drivers/drivers.schemas";
import { toQueryShape } from "./query-shape";
import { GetByIdArgs, type ToolDefinition } from "./tool.types";

// Drivers read tools (ADR-0043 c3 stage one). Driver rows carry Tier-2 PII —
// the registry's redaction pass strips dateOfBirth and masks licenseNumber to
// its last 4 before any result enters model context (c6); fullName and phone
// pass as operational contact data (PO-accepted).

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
  ];
}
