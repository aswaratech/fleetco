import Link from "next/link";
import { redirect } from "next/navigation";

import { Button } from "@/components/ui/button";
import { getServerSession } from "@/lib/session";

import { SignOutButton } from "./sign-out-button";

export default async function HomePage() {
  const session = await getServerSession();
  if (!session) {
    redirect("/login");
  }

  return (
    <main className="bg-surface-canvas flex min-h-svh items-center justify-center p-4">
      <div className="border-border-subtle bg-surface-raised w-full max-w-md space-y-6 rounded border p-6 shadow-sm">
        <div className="space-y-1">
          <h1 className="text-text-primary text-2xl font-semibold">FleetCo</h1>
          <p className="text-text-muted text-sm">
            Signed in as <span className="text-text-primary">{session.user.email}</span>.
          </p>
        </div>
        <nav aria-label="Primary" className="space-y-2">
          <Button asChild variant="outline" className="w-full justify-start">
            <Link href="/vehicles">Vehicles</Link>
          </Button>
          <Button asChild variant="outline" className="w-full justify-start">
            <Link href="/drivers">Drivers</Link>
          </Button>
          <Button asChild variant="outline" className="w-full justify-start">
            <Link href="/trips">Trips</Link>
          </Button>
          <Button asChild variant="outline" className="w-full justify-start">
            <Link href="/customers">Customers</Link>
          </Button>
          <Button asChild variant="outline" className="w-full justify-start">
            <Link href="/jobs">Jobs</Link>
          </Button>
          <Button asChild variant="outline" className="w-full justify-start">
            <Link href="/fuel-logs">Fuel logs</Link>
          </Button>
          <Button asChild variant="outline" className="w-full justify-start">
            <Link href="/expense-logs">Expense logs</Link>
          </Button>
        </nav>
        <SignOutButton />
      </div>
    </main>
  );
}
