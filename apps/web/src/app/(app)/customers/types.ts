// Web-side view of the API's Customer row. Mirrors the Prisma model in
// apps/api/prisma/schema.prisma (model Customer) at the field level;
// dates arrive as ISO strings over the JSON wire so they are typed as
// `string` here rather than `Date` to avoid a hidden coercion surface.
// Both the list endpoint and the detail endpoint return this shape;
// promoting to a shared @fleetco/shared package is deferred until a
// second app (driver app, Phase 2) needs the type — same calculus as
// apps/web/src/app/drivers/types.ts.
//
// The iter-15 read path does not surface a write form; the iter-16
// kickoff adds CreateCustomerFormSchema / UpdateCustomerFormSchema in
// apps/web/src/lib/customers-schema.ts the same way Drivers did
// between iters 6 and 7.
export interface Customer {
  id: string;
  name: string;
  contactPerson: string | null;
  phone: string;
  email: string | null;
  panNumber: string | null;
  address: string | null;
  status: "ACTIVE" | "INACTIVE";
  createdById: string;
  createdAt: string;
  updatedAt: string;
}
