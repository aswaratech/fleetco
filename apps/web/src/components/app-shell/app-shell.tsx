"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { ChevronsUpDown, LogOut, PanelLeft } from "lucide-react";

import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { authClient } from "@/lib/auth-client";
import { HOME, navForRole, type NavItem, type Role } from "@/lib/nav";
import { cn } from "@/lib/utils";

// The authenticated navigation shell (DESIGN.md §Navigation; the locked mockup
// docs/design/slices/app-shell.html). A client component because every part is
// interactive — the active-route highlight (usePathname), the 240px↔64px
// collapse (persisted to localStorage), the user menu, and sign-out. The server
// (app)/layout.tsx does the auth gate + role fetch and passes only serializable
// props; this renders navForRole(role) directly so the Lucide icon components
// (which cannot cross the server→client boundary as props) are imported in
// client code. The page renders its own <main> in the content slot, so there is
// exactly one <main> per document.
//
// Scope notes: the ⌘K command-palette affordance and the mobile Sheet drawer are
// deferred (cmdk is the separate T7 dependency ticket; Sheet is still
// contract-only). The shell is desktop-first with the documented collapse.

interface AppShellProps {
  email: string;
  name: string;
  role: Role;
  children: React.ReactNode;
}

const COLLAPSE_STORAGE_KEY = "fleetco:sidebar-collapsed";

// Active when the path equals the item href or sits beneath it; "/" only matches
// exactly. The caller resolves ties by longest match so /service-schedules/due
// highlights "Services due", not its parent "Service schedules".
function matchesPath(pathname: string, href: string): boolean {
  if (href === "/") return pathname === "/";
  return pathname === href || pathname.startsWith(`${href}/`);
}

function avatarInitial(name: string, email: string): string {
  const source = name.trim() || email;
  return (source[0] ?? "?").toUpperCase();
}

function NavLink({
  item,
  active,
  collapsed,
}: {
  item: NavItem;
  active: boolean;
  collapsed: boolean;
}): React.ReactElement {
  const Icon = item.icon;
  return (
    <Link
      href={item.href}
      title={collapsed ? item.label : undefined}
      aria-current={active ? "page" : undefined}
      className={cn(
        "flex h-9 items-center rounded text-sm font-medium",
        collapsed ? "mx-auto w-12 justify-center px-0" : "gap-3 px-3",
        active
          ? "bg-accent-primary text-accent-foreground"
          : "text-text-secondary hover:bg-surface-muted hover:text-text-primary",
      )}
    >
      <Icon className="size-5 shrink-0" strokeWidth={1.5} aria-hidden="true" />
      {!collapsed && <span className="flex-1 truncate">{item.label}</span>}
    </Link>
  );
}

export function AppShell({ email, name, role, children }: AppShellProps): React.ReactElement {
  const pathname = usePathname();
  const router = useRouter();
  const [collapsed, setCollapsed] = React.useState(false);
  const [signingOut, setSigningOut] = React.useState(false);

  // Restore the persisted collapse preference after mount. Initial render stays
  // expanded so server and first client render agree (no hydration mismatch).
  React.useEffect(() => {
    setCollapsed(window.localStorage.getItem(COLLAPSE_STORAGE_KEY) === "1");
  }, []);

  function toggleCollapsed(): void {
    setCollapsed((current) => {
      const next = !current;
      window.localStorage.setItem(COLLAPSE_STORAGE_KEY, next ? "1" : "0");
      return next;
    });
  }

  async function signOut(): Promise<void> {
    setSigningOut(true);
    await authClient.signOut();
    router.push("/login");
    router.refresh();
  }

  const groups = navForRole(role);
  const items = HOME.allowedRoles.includes(role)
    ? [HOME, ...groups.flatMap((group) => group.items)]
    : groups.flatMap((group) => group.items);
  // Longest matching href wins, so the most specific item is the active one.
  const activeHref = items
    .filter((item) => matchesPath(pathname, item.href))
    .sort((a, b) => b.href.length - a.href.length)[0]?.href;

  const showHome = HOME.allowedRoles.includes(role);

  return (
    <div className="flex min-h-svh">
      <aside
        className={cn(
          "bg-surface-raised border-border-subtle sticky top-0 flex h-svh shrink-0 flex-col self-start border-r transition-[width] duration-150",
          collapsed ? "w-16" : "w-60",
        )}
      >
        <div
          className={cn(
            "border-border-subtle flex h-14 shrink-0 items-center border-b",
            collapsed ? "justify-center px-0" : "gap-2.5 px-4",
          )}
        >
          <span className="bg-accent-primary text-accent-foreground flex size-7 shrink-0 items-center justify-center rounded text-sm font-semibold">
            F
          </span>
          {!collapsed && (
            <span className="text-text-primary text-[15px] font-semibold tracking-[-0.01em]">
              FleetCo
            </span>
          )}
        </div>

        <nav
          aria-label="Primary"
          className={cn("flex-1 overflow-y-auto py-3", collapsed ? "px-2" : "px-3")}
        >
          {showHome && (
            <div className="flex flex-col gap-0.5">
              <NavLink item={HOME} active={HOME.href === activeHref} collapsed={collapsed} />
            </div>
          )}
          {groups.map((group) => (
            <div key={group.id} className="mt-4 first:mt-0">
              {collapsed ? (
                <div className="bg-border-subtle mx-2 mb-2.5 h-px" aria-hidden="true" />
              ) : (
                <div className="text-text-muted px-3 pb-1.5 text-xs font-medium">{group.label}</div>
              )}
              <div className="flex flex-col gap-0.5">
                {group.items.map((item) => (
                  <NavLink
                    key={item.href}
                    item={item}
                    active={item.href === activeHref}
                    collapsed={collapsed}
                  />
                ))}
              </div>
            </div>
          ))}
        </nav>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="bg-surface-raised border-border-subtle sticky top-0 z-20 flex h-14 items-center gap-3 border-b px-4">
          <button
            type="button"
            onClick={toggleCollapsed}
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            className="text-text-secondary hover:bg-surface-muted hover:text-text-primary flex size-9 items-center justify-center rounded"
          >
            <PanelLeft className="size-5" strokeWidth={1.5} aria-hidden="true" />
          </button>

          <div className="flex-1" />

          <Popover>
            <PopoverTrigger asChild>
              <button
                type="button"
                aria-label="User menu"
                className="text-text-secondary hover:bg-surface-muted flex h-9 items-center gap-2 rounded py-0 pr-2 pl-1.5"
              >
                <span className="bg-surface-muted border-border-subtle text-text-secondary flex size-7 items-center justify-center rounded-full border text-xs font-semibold">
                  {avatarInitial(name, email)}
                </span>
                <span className="text-text-secondary hidden max-w-[180px] truncate text-[13px] sm:block">
                  {email}
                </span>
                <ChevronsUpDown className="size-4 shrink-0" strokeWidth={1.5} aria-hidden="true" />
              </button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-60 p-1.5">
              <div className="px-2.5 pt-2 pb-2.5">
                <div className="text-text-muted text-[11px]">Signed in as</div>
                <div className="text-text-primary mt-0.5 truncate text-[13px] font-medium">
                  {email}
                </div>
              </div>
              <div className="bg-border-subtle -mx-1.5 my-1 h-px" aria-hidden="true" />
              <button
                type="button"
                onClick={signOut}
                disabled={signingOut}
                className="text-text-secondary hover:bg-surface-muted hover:text-text-primary flex h-[34px] w-full items-center gap-2.5 rounded px-2.5 text-sm disabled:opacity-50"
              >
                <LogOut className="size-4 shrink-0" strokeWidth={1.5} aria-hidden="true" />
                {signingOut ? "Signing out…" : "Sign out"}
              </button>
            </PopoverContent>
          </Popover>
        </header>

        {children}
      </div>
    </div>
  );
}
