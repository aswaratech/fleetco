import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { Button } from "@/components/ui/button";
import { apiFetch, ApiError } from "@/lib/api";
import { DRIVER_STATUS_LABELS, LICENSE_CLASS_LABELS } from "@/lib/drivers-schema";
import { getServerSession } from "@/lib/session";

import type { Driver } from "../types";
import { DeleteDriverDialog } from "./delete-driver-dialog";

// Driver detail — iter 6 of the Drivers slice. Server-rendered shell
// (auth gate via getServerSession; redirect to /login if absent);
// fetches the driver via apiFetch and surfaces 404 through Next.js's
// notFound() route so /drivers/<bogus-id> renders the framework's
// standard not-found page.
//
// Edit / Delete CTAs land in the header right-side cluster. Iter 7
// wired them up alongside the write-path endpoints (POST/PATCH/DELETE).
// The Delete button opens a confirmation dialog (DeleteDriverDialog,
// a small client island around shadcn's AlertDialog); the action layer
// (../actions.ts:deleteDriverAction) issues DELETE and redirects on
// success.
//
// Field layout: a definition list (<dl>) under DESIGN.md §"Data display"
// typography tokens. Two-column on >= sm; stacks on narrow viewports.
// Mirrors apps/web/src/app/vehicles/[id]/page.tsx in shape.

interface DetailPageProps {
  params: Promise<{ id: string }>;
}

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  // Render YYYY-MM-DD; BS-calendar rendering arrives with the future
  // <NepaliDate> component per DESIGN.md §"BS calendar".
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function formatTimestamp(iso: string | null): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toISOString().replace("T", " ").slice(0, 19) + " UTC";
}

export default async function DriverDetailPage({
  params,
}: DetailPageProps): Promise<React.ReactElement> {
  const session = await getServerSession();
  if (!session) {
    redirect("/login");
  }

  const { id } = await params;

  let driver: Driver;
  try {
    driver = await apiFetch<Driver>(`/api/v1/drivers/${id}`);
  } catch (error) {
    if (error instanceof ApiError) {
      if (error.status === 401) {
        redirect("/login");
      }
      if (error.status === 404) {
        notFound();
      }
    }
    throw error;
  }

  return (
    <main className="bg-surface-canvas min-h-svh">
      <div className="mx-auto max-w-3xl space-y-6 px-8 py-8">
        <header className="flex items-end justify-between gap-4">
          <div className="space-y-1">
            <nav aria-label="Breadcrumb" className="text-text-muted text-sm">
              <Link href="/" className="hover:text-text-primary">
                FleetCo
              </Link>
              <span aria-hidden="true"> › </span>
              <Link href="/drivers" className="hover:text-text-primary">
                Drivers
              </Link>
              <span aria-hidden="true"> › </span>
              <span className="text-text-secondary">{driver.fullName}</span>
            </nav>
            <h1 className="text-text-primary text-2xl font-semibold">{driver.fullName}</h1>
            <p className="text-text-muted text-sm">
              {LICENSE_CLASS_LABELS[driver.licenseClass] ?? driver.licenseClass} ·{" "}
              {DRIVER_STATUS_LABELS[driver.status] ?? driver.status}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button asChild variant="outline">
              <Link href={`/drivers/${driver.id}/edit`}>Edit</Link>
            </Button>
            <DeleteDriverDialog id={driver.id} fullName={driver.fullName} />
          </div>
        </header>

        <section className="border-border-subtle bg-surface-raised rounded border p-6 shadow-sm">
          <dl className="grid grid-cols-1 gap-x-8 gap-y-4 sm:grid-cols-2">
            <DetailRow label="Full name" value={driver.fullName} />
            <DetailRow label="License number" value={driver.licenseNumber} mono />
            <DetailRow
              label="License class"
              value={LICENSE_CLASS_LABELS[driver.licenseClass] ?? driver.licenseClass}
            />
            <DetailRow label="Phone" value={driver.phone} mono />
            <DetailRow label="Date of birth" value={formatDate(driver.dateOfBirth)} />
            <DetailRow
              label="Status"
              value={DRIVER_STATUS_LABELS[driver.status] ?? driver.status}
            />
            <DetailRow label="Hired at" value={formatDate(driver.hiredAt)} />
            <DetailRow label="License expires" value={formatDate(driver.licenseExpiresAt)} />
            <DetailRow label="Terminated at" value={formatDate(driver.terminatedAt)} />
            <DetailRow label="Created at" value={formatTimestamp(driver.createdAt)} />
            <DetailRow label="Updated at" value={formatTimestamp(driver.updatedAt)} />
          </dl>
        </section>
      </div>
    </main>
  );
}

interface DetailRowProps {
  label: string;
  value: string;
  mono?: boolean;
  numeric?: boolean;
}

function DetailRow({ label, value, mono, numeric }: DetailRowProps): React.ReactElement {
  // Definition-list row — DESIGN.md §"Data display": Latin numerals,
  // tabular-nums for numeric values, mono for identifiers (license
  // number, phone), default sans for everything else.
  const valueClass = [
    "text-text-primary text-sm",
    mono ? "font-mono" : "",
    numeric ? "tabular-nums" : "",
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <div className="space-y-1">
      <dt className="text-text-muted text-xs font-medium uppercase tracking-wide">{label}</dt>
      <dd className={valueClass}>{value}</dd>
    </div>
  );
}
