import Link from "next/link";

import { Button } from "@/components/ui/button";
import { NAV } from "@/lib/nav";

// Zone B — Quick links. A compact convenience strip on the home dashboard. The
// Navigation sidebar (DESIGN.md §Navigation, now built) is the app's primary
// navigation; this strip is sourced from the SAME shared nav model
// (apps/web/src/lib/nav.ts) so the two cannot drift — one source of truth feeds
// the sidebar and this strip. Order follows the sidebar's grouping.

const QUICK_LINKS = NAV.flatMap((group) => group.items);

export function QuickLinks(): React.ReactElement {
  return (
    <section aria-labelledby="quick-links-heading" className="space-y-2">
      <h2
        id="quick-links-heading"
        className="text-text-muted text-xs font-medium tracking-wide uppercase"
      >
        Quick links
      </h2>
      <nav aria-label="Shortcuts" className="flex flex-wrap gap-2">
        {QUICK_LINKS.map((link) => (
          <Button key={link.href} asChild variant="outline" size="sm">
            <Link href={link.href}>{link.label}</Link>
          </Button>
        ))}
      </nav>
    </section>
  );
}
