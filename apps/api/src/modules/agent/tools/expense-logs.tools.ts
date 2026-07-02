import { ExpenseCategory } from "@prisma/client";
import { z } from "zod";

import { type ExpenseLogsService } from "../../expense-logs/expense-logs.service";
import {
  ListExpenseLogsQuerySchema,
  type ExpenseLogSortColumn,
} from "../../expense-logs/expense-logs.schemas";
import { toQueryShape } from "./query-shape";
import { GetByIdArgs, type ToolDefinition } from "./tool.types";

// Expense-log read tools (ADR-0043 c3 stage one). `category` is a SINGLE enum
// value (the module contract — not csv). A null vehicleId on a row means a
// company-level, vehicle-agnostic expense (e.g. the quarterly insurance
// premium).

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
  ];
}
