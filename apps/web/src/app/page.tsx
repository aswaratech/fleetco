import { redirect } from "next/navigation";

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
        <p className="text-text-secondary text-sm">
          Phase 0 placeholder home. The Vehicles slice (first Phase 1 ticket) mounts here.
        </p>
        <SignOutButton />
      </div>
    </main>
  );
}
