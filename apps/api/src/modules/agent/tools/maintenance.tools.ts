import { ServiceScheduleStatus } from "@prisma/client";
import { z } from "zod";

import { type ServiceRecordsService } from "../../maintenance/service-records.service";
import { type ServiceSchedulesService } from "../../maintenance/service-schedules.service";
import {
  ListServiceRecordsQuerySchema,
  type ServiceRecordSortColumn,
} from "../../maintenance/service-records.schemas";
import {
  ListServiceSchedulesQuerySchema,
  type ServiceScheduleSortColumn,
} from "../../maintenance/service-schedules.schemas";
import { toQueryShape } from "./query-shape";
import { GetByIdArgs, type ToolDefinition } from "./tool.types";

// Maintenance read tools (ADR-0043 c3 stage one): the two aggregates the
// MaintenanceModule exports. Interval semantics ride the descriptions so the
// model reasons in the right units (ADR-0037's integer-minor-units rule).

const SCHEDULE_SORT = ["name", "createdAt"] as const satisfies readonly ServiceScheduleSortColumn[];

const RECORD_SORT = [
  "performedAt",
  "createdAt",
] as const satisfies readonly ServiceRecordSortColumn[];

const ListServiceSchedulesArgs = z
  .object({
    vehicleId: z.string().trim().min(1).optional(),
    status: z.array(z.enum(ServiceScheduleStatus)).optional(),
    sortBy: z.enum(SCHEDULE_SORT).optional(),
    sortDir: z.enum(["asc", "desc"]).optional(),
    skip: z.number().int().min(0).optional(),
    take: z.number().int().min(1).max(200).optional(),
  })
  .strict();

const ListServiceRecordsArgs = z
  .object({
    vehicleId: z.string().trim().min(1).optional(),
    serviceScheduleId: z.string().trim().min(1).optional(),
    sortBy: z.enum(RECORD_SORT).optional(),
    sortDir: z.enum(["asc", "desc"]).optional(),
    skip: z.number().int().min(0).optional(),
    take: z.number().int().min(1).max(200).optional(),
  })
  .strict();

export function buildMaintenanceTools(
  serviceSchedules: ServiceSchedulesService,
  serviceRecords: ServiceRecordsService,
): ToolDefinition[] {
  return [
    {
      name: "list_service_schedules",
      description:
        "List preventive-maintenance schedules with optional vehicleId/status " +
        "filters, sorting, pagination (take ≤ 200). intervalValue units depend on " +
        "intervalType: DISTANCE_KM = integer km, ENGINE_HOURS = integer " +
        "tenths-of-an-hour, CALENDAR_DAYS = days. For due/overdue reasoning, " +
        "compare a schedule's lastService anchor + interval against the vehicle's " +
        "current meter (get_vehicle) or today's date.",
      capabilities: ["maintenance:*"],
      riskTier: "read",
      argsSchema: ListServiceSchedulesArgs,
      async execute(args) {
        const query = ListServiceSchedulesQuerySchema.parse(
          toQueryShape(ListServiceSchedulesArgs.parse(args)),
        );
        return serviceSchedules.list(query);
      },
    },
    {
      name: "get_service_schedule",
      description:
        "Fetch one service schedule by id: name, interval type/value, status, and " +
        "the last-service anchor (date + meter readings).",
      capabilities: ["maintenance:*"],
      riskTier: "read",
      argsSchema: GetByIdArgs,
      async execute(args) {
        const { id } = GetByIdArgs.parse(args);
        return serviceSchedules.getById(id);
      },
    },
    {
      name: "list_service_records",
      description:
        "List performed-service records with optional vehicleId/serviceScheduleId " +
        "filters, sorting (default: performedAt), pagination (take ≤ 200). Costs " +
        "ride the linked expense log; meter readings are integer km / " +
        "tenths-of-an-hour.",
      capabilities: ["maintenance:*"],
      riskTier: "read",
      argsSchema: ListServiceRecordsArgs,
      async execute(args) {
        const query = ListServiceRecordsQuerySchema.parse(
          toQueryShape(ListServiceRecordsArgs.parse(args)),
        );
        return serviceRecords.list(query);
      },
    },
    {
      name: "get_service_record",
      description: "Fetch one service record by id (what was done, when, at what meter).",
      capabilities: ["maintenance:*"],
      riskTier: "read",
      argsSchema: GetByIdArgs,
      async execute(args) {
        const { id } = GetByIdArgs.parse(args);
        return serviceRecords.getById(id);
      },
    },
  ];
}
