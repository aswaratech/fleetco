import { JobStatus } from "@prisma/client";
import { z } from "zod";

import { type JobsService } from "../../jobs/jobs.service";
import { ListJobsQuerySchema, type JobSortColumn } from "../../jobs/jobs.schemas";
import { toQueryShape } from "./query-shape";
import { GetByIdArgs, type ToolDefinition } from "./tool.types";

// Jobs read tools (ADR-0043 c3 stage one). JobsService.getById throws
// NotFoundException itself — propagated as-is.

const JOB_SORT = [
  "createdAt",
  "jobNumber",
  "scheduledStartDate",
] as const satisfies readonly JobSortColumn[];

const ListJobsArgs = z
  .object({
    status: z.array(z.enum(JobStatus)).optional(),
    customerId: z.string().trim().min(1).optional(),
    sortBy: z.enum(JOB_SORT).optional(),
    sortDir: z.enum(["asc", "desc"]).optional(),
    skip: z.number().int().min(0).optional(),
    take: z.number().int().min(1).max(200).optional(),
  })
  .strict();

export function buildJobsTools(jobs: JobsService): ToolDefinition[] {
  return [
    {
      name: "list_jobs",
      description:
        "List jobs (JOB-YYYY-NNNNN numbered work orders) with optional status and " +
        "customerId filters, sorting, and pagination (take ≤ 200). Dates are ISO.",
      capabilities: ["jobs:*"],
      riskTier: "read",
      argsSchema: ListJobsArgs,
      async execute(args) {
        const query = ListJobsQuerySchema.parse(toQueryShape(ListJobsArgs.parse(args)));
        return jobs.list(query);
      },
    },
    {
      name: "get_job",
      description:
        "Fetch one job by id, including its nested customer, description, status, " +
        "and scheduled/actual start/end dates (ISO).",
      capabilities: ["jobs:*"],
      riskTier: "read",
      argsSchema: GetByIdArgs,
      async execute(args) {
        const { id } = GetByIdArgs.parse(args);
        return jobs.getById(id);
      },
    },
  ];
}
