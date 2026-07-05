import { NotFoundException } from "@nestjs/common";
import { CustomerStatus } from "@prisma/client";
import { z } from "zod";

import { type CustomersService } from "../../customers/customers.service";
import {
  CreateCustomerSchema,
  ListCustomersQuerySchema,
  UpdateCustomerSchema,
  type CustomerSortColumn,
} from "../../customers/customers.schemas";
import { toQueryShape } from "./query-shape";
import { GetByIdArgs, type ToolDefinition } from "./tool.types";

// Customers tools (ADR-0043 c3: A4 reads, A7 create; ADR-0044 P2 update).
// Customer contactPerson / phone / email pass the redaction layer as
// operational contact data (c6). The write paths leave PAN normalization
// (trim + uppercase, the case-insensitive uniqueness) to the service, where
// it has always lived.

const CUSTOMER_SORT = ["name", "createdAt"] as const satisfies readonly CustomerSortColumn[];

// Mirrors CreateCustomerSchema field-for-field (nullability included). The
// single-@ email refine stays module-side (wrappers teach shape; the module
// re-validates content at execute).
const CreateCustomerArgs = z
  .object({
    name: z.string().trim().min(1).max(256),
    contactPerson: z.string().trim().min(1).max(128).nullable().optional(),
    phone: z.string().trim().min(1),
    email: z.string().trim().min(1).max(256).nullable().optional(),
    panNumber: z.string().trim().min(1).max(32).nullable().optional(),
    address: z.string().trim().min(1).max(512).nullable().optional(),
    status: z.enum(CustomerStatus).optional(),
  })
  .strict();

// Mirrors UpdateCustomerSchema (CreateCustomerSchema.partial()) field-for-field
// plus the wrapper-only `id`. Explicit null CLEARS a clearable field
// (contactPerson, email, panNumber, address); name / phone / status are
// replaced, never cleared. The module schema's empty-patch refine re-validates
// at execute.
const UpdateCustomerArgs = z
  .object({
    id: z.string().trim().min(1),
    name: z.string().trim().min(1).max(256).optional(),
    contactPerson: z.string().trim().min(1).max(128).nullable().optional(),
    phone: z.string().trim().min(1).optional(),
    email: z.string().trim().min(1).max(256).nullable().optional(),
    panNumber: z.string().trim().min(1).max(32).nullable().optional(),
    address: z.string().trim().min(1).max(512).nullable().optional(),
    status: z.enum(CustomerStatus).optional(),
  })
  .strict();

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
    {
      name: "create_customer",
      description:
        "Register a new customer. Required: name (the business name), phone (a " +
        "Nepal number). Optional: contactPerson, email, panNumber (unique when " +
        "present — a duplicate fails with a conflict; normalized to uppercase " +
        "server-side), address, status (ACTIVE/INACTIVE). The write happens " +
        "immediately and exactly once; the result includes the new customer's id.",
      capabilities: ["customers:*"],
      riskTier: "reversible-write",
      resultEntityType: "Customer",
      argsSchema: CreateCustomerArgs,
      async execute(args, actor) {
        const input = CreateCustomerSchema.parse(CreateCustomerArgs.parse(args));
        return customers.create(input, actor.userId);
      },
    },
    {
      name: "update_customer",
      description:
        "Update fields on an existing customer (partial update — send only what " +
        "changes; the prior row is captured for undo). Explicit null CLEARS " +
        "contactPerson, email, panNumber, or address. Setting status to INACTIVE " +
        "deactivates the customer. panNumber stays unique (a duplicate fails with " +
        "a conflict; normalized to uppercase server-side). The write happens " +
        "immediately and exactly once.",
      capabilities: ["customers:*"],
      riskTier: "reversible-write",
      resultEntityType: "Customer",
      argsSchema: UpdateCustomerArgs,
      async capturePreImage(args) {
        const { id } = UpdateCustomerArgs.parse(args);
        return customers.findById(id);
      },
      async execute(args) {
        const { id, ...patch } = UpdateCustomerArgs.parse(args);
        const input = UpdateCustomerSchema.parse(patch);
        const updated = await customers.update(id, input);
        if (updated === null) {
          throw new NotFoundException(`Customer ${id} not found.`);
        }
        return updated;
      },
    },
  ];
}
