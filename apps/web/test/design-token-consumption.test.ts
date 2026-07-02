import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

/**
 * Token CONSUMPTION guard (DESIGN.md §"How this file relates to code" →
 * "Token consumption, not just definition"). The sibling
 * `design-token-drift.test.ts` proves DESIGN.md's hex values match the
 * `@theme` block; this test proves the components actually CONSUME the live
 * `@theme` utilities and never a dead `:root` shadcn alias.
 *
 * Why it exists: in Tailwind 4 only `@theme` `--color-*` variables become
 * utility classes. The sibling `:root` block aliases shadcn's standard names
 * (`--primary`, `--input`, `--ring`, …) as PLAIN CSS variables — they generate
 * no utilities, so `bg-primary` / `border-input` / `ring-ring` are DEAD classes
 * that compile to nothing. A primary button wired to `bg-primary` rendered
 * transparent for many tickets while the drift test stayed green, because the
 * drift test checks DEFINITIONS, not CONSUMPTION. This guard closes that hole:
 * paste an upstream shadcn component whose `:root`-alias classes are inert here
 * and the test goes red until it is re-pointed (popover.tsx is the template).
 */

const WEB_ROOT = join(__dirname, "..");
const UI_DIR = join(WEB_ROOT, "src", "components", "ui");
const GLOBALS_CSS = readFileSync(join(WEB_ROOT, "src", "app", "globals.css"), "utf-8");

/** Returns the inner body of a top-level `selector { ... }` block. */
function blockBody(css: string, header: RegExp): string {
  const match = css.match(header);
  if (!match) throw new Error(`block not found in globals.css: ${header}`);
  return match[1];
}

// Live color-utility roots: every `--color-X` declared in @theme becomes the
// Tailwind utility root `X` (e.g. `--color-accent-primary` → `bg-accent-primary`).
const themeBody = blockBody(GLOBALS_CSS, /@theme\s*\{([\s\S]*?)\n\}/);
const liveColorRoots = new Set(
  [...themeBody.matchAll(/--color-([a-z0-9-]+)\s*:/g)].map((m) => m[1]),
);

// shadcn aliases: every `--X` in the `:root` block. A color utility `bg-X` is
// LIVE iff `--color-X` exists in @theme (i.e. `X` is a live root above); the
// `:root` aliases declare `--X` with no `color-` prefix, so any alias whose
// matching `--color-X` is absent yields dead utilities — those are the ones a
// component must never consume. Note `accent-foreground` exists in BOTH blocks
// (`:root --accent-foreground` = text.primary AND `@theme --color-accent-
// foreground` = white): the UTILITY resolves to the @theme value, so
// `text-accent-foreground` is live (white) — that is "the trap" the re-point
// must respect (default button keeps it; ghost/outline hover uses text-primary).
const rootBody = blockBody(GLOBALS_CSS, /:root\s*\{([\s\S]*?)\n\}/);
const deadAliases = [...rootBody.matchAll(/--([a-z0-9-]+)\s*:/g)]
  .map((m) => m[1])
  .filter((alias) => !liveColorRoots.has(alias));

// The Tailwind utility prefixes that resolve a `--color-*` value. A dead
// consumption is any `${prefix}-${deadAlias}` class token.
const COLOR_PREFIXES = [
  "bg",
  "text",
  "border",
  "ring",
  "ring-offset",
  "fill",
  "stroke",
  "outline",
  "decoration",
  "shadow",
  "from",
  "via",
  "to",
  "accent",
  "caret",
  "divide",
];

// Strip block + line comments so prose that merely mentions a dead alias
// (e.g. popover.tsx's provenance note "bg-popover → bg-surface-elevated") is
// not a false positive. The line-comment strip preserves `://` inside URLs.
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

/**
 * Returns the dead-alias utility class tokens a component references. The
 * lookbehind/lookahead boundaries (`[\w-]`) stop a LIVE utility that merely
 * contains a dead token as a substring (e.g. `text-text-primary` contains
 * `text-primary`; `border-border-subtle` contains `border-border`) from
 * matching — only a standalone class token (optionally `variant:`-prefixed
 * and `/opacity`-suffixed) counts.
 */
function deadTokensIn(src: string): string[] {
  const code = stripComments(src);
  const hits = new Set<string>();
  for (const alias of deadAliases) {
    for (const prefix of COLOR_PREFIXES) {
      const util = `${prefix}-${alias}`;
      const re = new RegExp(`(?<![\\w-])${util}(?:/\\d+)?(?![\\w-])`);
      if (re.test(code)) hits.add(util);
    }
  }
  return [...hits].sort();
}

const uiFiles = readdirSync(UI_DIR).filter((f) => f.endsWith(".tsx"));

/**
 * Recursive walk for the app-wide sweep. The 2026-07-02 audit found the exact
 * defect class this guard exists for — 68 dead-alias occurrences across 27
 * route files — living one directory over from the only dir this test used to
 * scan (`components/ui`), invisible to CI. Route files, shared components, and
 * lib class-string constants are all consumers; scan them all.
 */
function walkSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walkSourceFiles(full));
    } else if (/\.tsx?$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

const APP_WIDE_DIRS = ["src/app", "src/components", "src/lib"] as const;
const appWideFiles = APP_WIDE_DIRS.flatMap((d) => walkSourceFiles(join(WEB_ROOT, d)));

describe("design-token consumption: no component consumes a dead :root alias", () => {
  test("the dead-alias set parses from globals.css (guard is not vacuous)", () => {
    // If the parse ever breaks, deadAliases empties and every file trivially
    // passes — assert the known dead aliases are present so that can't happen.
    for (const alias of ["primary", "input", "ring", "destructive", "muted"]) {
      expect(deadAliases).toContain(alias);
    }
  });

  test("there is at least one ui component to scan", () => {
    expect(uiFiles.length).toBeGreaterThan(0);
  });

  for (const file of uiFiles) {
    test(`${file} consumes only live @theme utilities`, () => {
      const dead = deadTokensIn(readFileSync(join(UI_DIR, file), "utf-8"));
      expect(
        dead,
        `${file} references dead shadcn-alias utilities ${JSON.stringify(dead)} that ` +
          `generate no CSS in this project (Tailwind 4 only emits utilities for @theme ` +
          `--color-* tokens; these live in the :root alias block). Re-point to the @theme ` +
          `semantic utilities as apps/web/src/components/ui/popover.tsx does. See DESIGN.md ` +
          `§"How this file relates to code" → "Token consumption, not just definition".`,
      ).toEqual([]);
    });
  }
});

describe("design-token consumption: the app-wide sweep (src/app + src/components + src/lib)", () => {
  test("the walker finds a plausible file count (guard is not vacuous)", () => {
    // The (app) route group alone holds ~25 aggregates' pages; a collapse of
    // this number means the walk broke, not that the app shrank.
    expect(appWideFiles.length).toBeGreaterThan(50);
  });

  // One test per file keeps the failure report actionable (the offending file
  // and its dead tokens are named directly).
  for (const file of appWideFiles) {
    const rel = file.slice(WEB_ROOT.length + 1);
    test(`${rel} consumes only live @theme utilities`, () => {
      const dead = deadTokensIn(readFileSync(file, "utf-8"));
      expect(
        dead,
        `${rel} references dead shadcn-alias utilities ${JSON.stringify(dead)} that ` +
          `generate no CSS here (only @theme --color-* tokens emit utilities; the :root ` +
          `aliases do not). Re-point to the live pattern ui/input.tsx uses — e.g. ` +
          `border-input → border-border-strong, focus-visible:border-ring → ` +
          `focus-visible:border-border-focus, aria-invalid:border-destructive → ` +
          `aria-invalid:border-status-error.`,
      ).toEqual([]);
    });
  }
});

describe("design-token consumption: live tokens on the primary paths", () => {
  test("button's default variant uses the emerald accent (color.accent.*)", () => {
    const src = readFileSync(join(UI_DIR, "button.tsx"), "utf-8");
    expect(src).toMatch(/\bbg-accent-primary\b/);
    expect(src).toMatch(/\btext-accent-foreground\b/);
    expect(src).toMatch(/\bhover:bg-accent-primary-hover\b/);
  });

  test("input uses the strong border + focus-ring tokens", () => {
    const src = readFileSync(join(UI_DIR, "input.tsx"), "utf-8");
    expect(src).toMatch(/\bborder-border-strong\b/);
    expect(src).toMatch(/\bfocus-visible:ring-border-focus\b/);
  });

  test("form validation message uses color.status.error (renders red)", () => {
    const src = readFileSync(join(UI_DIR, "form.tsx"), "utf-8");
    expect(src).toMatch(/\btext-status-error\b/);
    expect(src).not.toMatch(/\btext-destructive\b/);
  });
});

describe("design-token consumption: radius conforms to DESIGN.md §Borders", () => {
  // Controls = radius.default `rounded` (4px); popover/dropdown surfaces =
  // radius.lg `rounded-lg` (8px). Nothing ships shadcn's default 6px
  // (`rounded-md`).
  test("control primitives use rounded (4px), never rounded-md (6px)", () => {
    for (const file of ["button.tsx", "input.tsx", "select.tsx"]) {
      const src = stripComments(readFileSync(join(UI_DIR, file), "utf-8"));
      expect(src, `${file} must not ship shadcn's 6px rounded-md`).not.toMatch(/\brounded-md\b/);
      expect(src, `${file} must use radius.default (rounded)`).toMatch(/\brounded\b/);
    }
  });

  test("popover/select content surfaces use rounded-lg (8px)", () => {
    for (const file of ["popover.tsx", "select.tsx"]) {
      const src = readFileSync(join(UI_DIR, file), "utf-8");
      expect(src, `${file} content surface should be rounded-lg`).toMatch(/\brounded-lg\b/);
    }
  });
});
