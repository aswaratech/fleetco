import { redirect } from "next/navigation";

import { AppShell } from "@/components/app-shell/app-shell";
import { ApiError, apiFetch } from "@/lib/api";
import type { Role } from "@/lib/nav";
import { getServerSession } from "@/lib/session";

// Layout for every authenticated route (the (app) route group). It is the
// single auth gate + the navigation shell host. A server component:
//   1. getServerSession() → redirect("/login") when unauthenticated. The
//      session carries the email + name shown in the top bar.
//   2. GET /me for the role (ADR-0028 exposes it precisely so the web can gate
//      UI; the API stays the security boundary). 401 → /login; any other error
//      rethrows to the route group's error boundary rather than rendering a
//      shell around a broken page.
// The role is the only RBAC input the shell needs; the client <AppShell> renders
// navForRole(role) itself (the Lucide icon components in the nav model are not
// serializable across the server→client boundary, so they cannot be passed as
// props). This layout is THE auth gate for the whole route group: the
// once-redundant per-page getServerSession copies were removed when the
// tech-debt entry's trigger fired (a page-level defense that remains is each
// data-fetching page's ApiError-401 → /login catch, which guards mid-session
// expiry during a fetch — a different concern from this gate).

interface Me {
  id: string;
  email: string;
  role: Role;
}

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}): Promise<React.ReactElement> {
  const session = await getServerSession();
  if (!session) {
    redirect("/login");
  }

  let role: Role;
  try {
    const me = await apiFetch<Me>("/me");
    role = me.role;
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      redirect("/login");
    }
    throw error;
  }

  return (
    <AppShell email={session.user.email} name={session.user.name} role={role}>
      {children}
    </AppShell>
  );
}
