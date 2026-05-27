import type { Customer } from "../customers/types";

// Web-side view of the API's Job rows. Mirrors the Prisma model in
// apps/api/prisma/schema.prisma (model Job) and the API's LIST_SELECT /
// DETAIL_INCLUDE shapes (apps/api/src/modules/jobs/jobs.service.ts).
// Dates arrive as ISO strings over the JSON wire, so they are typed as
// `string` here rather than `Date` — same convention as the Trips /
// Customers web types. Promoting to a shared @fleetco/shared package is
// deferred until a second app needs the type.
//
// The list endpoint returns the slim projection (JobListItem — the
// customer reduced to `{ id, name }`); the detail endpoint returns
// JobDetail with the full nested Customer so the detail page can render
// the customer block and deep-link to /customers/<id>.
//
// iter 17 is read-only; the iter-18 write path adds
// CreateJobFormSchema / UpdateJobFormSchema in apps/web/src/lib/
// jobs-schema.ts the same way Customers did between iters 15 and 16.

export type JobStatus = "PLANNED" | "IN_PROGRESS" | "COMPLETED" | "CANCELLED";

// List-endpoint item: the slim Customer projection (`id` + `name`),
// matching the API's LIST_SELECT.
export interface JobListItem {
  id: string;
  jobNumber: string;
  customerId: string;
  description: string;
  status: JobStatus;
  scheduledStartDate: string | null;
  scheduledEndDate: string | null;
  actualStartDate: string | null;
  actualEndDate: string | null;
  notes: string | null;
  createdById: string;
  createdAt: string;
  updatedAt: string;
  customer: {
    id: string;
    name: string;
  };
}

// Detail-endpoint shape: full nested Customer (the API's DETAIL_INCLUDE).
// Reuses the Customer type from the sibling slice so a Customer schema
// change ripples here automatically.
export interface JobDetail {
  id: string;
  jobNumber: string;
  customerId: string;
  description: string;
  status: JobStatus;
  scheduledStartDate: string | null;
  scheduledEndDate: string | null;
  actualStartDate: string | null;
  actualEndDate: string | null;
  notes: string | null;
  createdById: string;
  createdAt: string;
  updatedAt: string;
  customer: Customer;
}

// Display-friendly status labels. The list page and the detail page
// both use this mapping. Lives in the web types module (not a
// lib/jobs-schema) because iter 17 ships no form; the iter-18 write
// path may move the canonical option list into lib/jobs-schema.ts
// alongside the form schemas, the same way Customers did.
export const JOB_STATUS_OPTIONS = [
  { value: "PLANNED", label: "Planned" },
  { value: "IN_PROGRESS", label: "In progress" },
  { value: "COMPLETED", label: "Completed" },
  { value: "CANCELLED", label: "Cancelled" },
] as const;

export const JOB_STATUS_LABELS: Record<JobStatus, string> = Object.fromEntries(
  JOB_STATUS_OPTIONS.map(({ value, label }) => [value, label]),
) as Record<JobStatus, string>;
