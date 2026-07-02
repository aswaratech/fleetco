import { NotFoundException } from "@nestjs/common";
import { CustomerStatus } from "@prisma/client";
import { z } from "zod";

import { type CustomersService } from "../../customers/customers.service";
import {
  ListCustomersQuerySchema,
  type CustomerSortColumn,
} from "../../customers/customers.schemas";
import { toQueryShape } from "./query-shape";
import { GetByIdArgs, type ToolDefinition } from "./tool.types";

// Customers read tools (ADR-0043 c3 stage one). Customer contactPerson /
// phone / email pass the redaction layer as operational contact data (c6).

const CUSTOMER_SORT = ["name", "createdAt"] as const satisfies readonly CustomerSortColumn[];

const ListCustomersArgs = z
  .object({
    status: z.array(z.enum(CustomerStatus)).optional(),
    sortBy: z.enum(CUSTOMER_SORT).optional(),
    sortDir: z.enum(["asc", "desc"]).optional(),
    skip: z.number().int().min(0).optional(),
    take: z.number().int().min(1).max(200).optional(),
  })
  .strict();

export function buildCustomersTools(customers: CustomersService): ToolDefinition[] {
  return [
    {
      name: "list_customers",
      description:
        "List customers with an optional status filter (ACTIVE/INACTIVE), sorting, " +
        "and pagination (take ≤ 200).",
      capabilities: ["customers:*"],
      riskTier: "read",
      argsSchema: ListCustomersArgs,
      async execute(args) {
        const query = ListCustomersQuerySchema.parse(toQueryShape(ListCustomersArgs.parse(args)));
        return customers.list(query);
      },
    },
    {
      name: "get_customer",
      description:
        "Fetch one customer by id: business name, contact person, phone, email, " +
        "PAN number, address, status.",
      capabilities: ["customers:*"],
      riskTier: "read",
      argsSchema: GetByIdArgs,
      async execute(args) {
        const { id } = GetByIdArgs.parse(args);
        const customer = await customers.findById(id);
        if (customer === null) {
          throw new NotFoundException(`Customer ${id} not found.`);
        }
        return customer;
      },
    },
  ];
}
