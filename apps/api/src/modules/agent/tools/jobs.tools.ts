import { JobStatus } from "@prisma/client";
import { z } from "zod";

import { type JobsService } from "../../jobs/jobs.service";
import { CreateJobSchema, ListJobsQuerySchema, type JobSortColumn } from "../../jobs/jobs.schemas";
import { toQueryShape } from "./query-shape";
import { GetByIdArgs, type ToolDefinition } from "./tool.types";

// Jobs tools (ADR-0043 c3: A4 reads, A7 create). JobsService.getById throws
// NotFoundException itself — propagated as-is. The jobNumber is generated
// server-side (JOB-YYYY-NNNNN with a P2002 retry) — the create wrapper
// structurally cannot supply one, and its description says so.

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

// Mirrors CreateJobSchema field-for-field, minus its superRefine (the
// end-≥-start date-pair rules re-validate module-side at execute and surface
// as the house 400 the model can correct).
const CreateJobArgs = z
  .object({
    customerId: z.string().min(1),
    description: z.string().trim().min(1).max(2048),
    status: z.enum(JobStatus).optional(),
    scheduledStartDate: z.iso.date().nullable().optional(),
    scheduledEndDate: z.iso.date().nullable().optional(),
    actualStartDate: z.iso.date().nullable().optional(),
    actualEndDate: z.iso.date().nullable().optional(),
    notes: z.string().max(4096).nullable().optional(),
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
    {
      name: "create_job",
      description:
        "Create a new job (work order) for a customer. Required: customerId " +
        "(resolve it with list_customers first — never guess), description. " +
        "Optional: status (defaults PLANNED), scheduled/actual start and end " +
        "dates (ISO YYYY-MM-DD; each end must be on or after its start), notes. " +
        "The job number (JOB-YYYY-NNNNN) is generated server-side — do not " +
        "supply one. The write happens immediately and exactly once; the result " +
        "includes the new job's id and number.",
      capabilities: ["jobs:*"],
      riskTier: "reversible-write",
      resultEntityType: "Job",
      argsSchema: CreateJobArgs,
      async execute(args, actor) {
        const input = CreateJobSchema.parse(CreateJobArgs.parse(args));
        return jobs.create(input, actor.userId);
      },
    },
  ];
}
