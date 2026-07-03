import { ExpenseCategory } from "@prisma/client";
import { z } from "zod";

import { type ExpenseLogsService } from "../../expense-logs/expense-logs.service";
import {
  CreateExpenseLogSchema,
  ListExpenseLogsQuerySchema,
  type ExpenseLogSortColumn,
} from "../../expense-logs/expense-logs.schemas";
import { toQueryShape } from "./query-shape";
import { GetByIdArgs, type ToolDefinition } from "./tool.types";

// Expense-log tools (ADR-0043 c3: A4 reads, A7 create). `category` is a
// SINGLE enum value (the module contract — not csv). A null vehicleId on a
// row means a company-level, vehicle-agnostic expense (e.g. the quarterly
// insurance premium) — and the create wrapper accepts the same shape.

const EXPENSE_LOG_SORT = [
  "date",
  "amountPaisa",
  "createdAt",
] as const satisfies readonly ExpenseLogSortColumn[];

const ListExpenseLogsArgs = z
  .object({
    vehicleId: z.string().trim().min(1).optional(),
    tripId: z.string().trim().min(1).optional(),
    category: z.enum(ExpenseCategory).optional(),
    startDate: z.iso.date().optional(),
    endDate: z.iso.date().optional(),
    sortBy: z.enum(EXPENSE_LOG_SORT).optional(),
    sortDir: z.enum(["asc", "desc"]).optional(),
    skip: z.number().int().min(0).optional(),
    take: z.number().int().min(1).max(200).optional(),
  })
  .strict();

// Mirrors CreateExpenseLogSchema field-for-field. amountPaisa is
// AUTHORITATIVE (no derivation — unlike fuel logs); vehicleId may be
// omitted/null for company-level expenses.
const CreateExpenseLogArgs = z
  .object({
    vehicleId: z.string().trim().min(1).nullable().optional(),
    tripId: z.string().trim().min(1).nullable().optional(),
    date: z.iso.date(),
    category: z.enum(ExpenseCategory),
    amountPaisa: z.number().int().min(1).max(10_000_000_000),
    vendor: z.string().trim().min(1).max(256).nullable().optional(),
    receiptNumber: z.string().trim().min(1).max(64).nullable().optional(),
    notes: z.string().max(4096).nullable().optional(),
  })
  .strict();

export function buildExpenseLogsTools(expenseLogs: ExpenseLogsService): ToolDefinition[] {
  return [
    {
      name: "list_expense_logs",
      description:
        "List expenses with optional vehicleId/tripId/category filters and an " +
        "inclusive startDate/endDate window (ISO YYYY-MM-DD), sorted (default: date " +
        "desc; amountPaisa sortable for 'biggest first'), paginated (take ≤ 200). " +
        "Money is integer PAISA (1 NPR = 100 paisa). Rows with a null vehicleId are " +
        "company-level, not vehicle-attributable.",
      capabilities: ["expense-logs:*"],
      riskTier: "read",
      argsSchema: ListExpenseLogsArgs,
      async execute(args) {
        const query = ListExpenseLogsQuerySchema.parse(
          toQueryShape(ListExpenseLogsArgs.parse(args)),
        );
        return expenseLogs.list(query);
      },
    },
    {
      name: "get_expense_log",
      description:
        "Fetch one expense log by id, including its nested vehicle/trip when bound. " +
        "Money integer paisa.",
      capabilities: ["expense-logs:*"],
      riskTier: "read",
      argsSchema: GetByIdArgs,
      async execute(args) {
        const { id } = GetByIdArgs.parse(args);
        return expenseLogs.getById(id);
      },
    },
    {
      name: "create_expense_log",
      description:
        "Record an expense. Required: date (ISO YYYY-MM-DD), category " +
        "(MAINTENANCE, REPAIR, TOLL, PARKING, INSURANCE, PERMIT, FINE, OTHER), " +
        "amountPaisa (integer PAISA, the authoritative amount: Rs. 1,500.00 = " +
        "150000). Optional: vehicleId (omit for a company-level expense like an " +
        "insurance premium; resolve real ids with list_vehicles), tripId (only " +
        "with a vehicleId, and the trip must belong to that vehicle), vendor, " +
        "receiptNumber, notes. The write happens immediately and exactly once; " +
        "the result includes the new expense log's id.",
      capabilities: ["expense-logs:*"],
      riskTier: "reversible-write",
      resultEntityType: "ExpenseLog",
      argsSchema: CreateExpenseLogArgs,
      async execute(args, actor) {
        const input = CreateExpenseLogSchema.parse(CreateExpenseLogArgs.parse(args));
        return expenseLogs.create(input, actor.userId);
      },
    },
  ];
}
