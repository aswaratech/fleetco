import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

const REPO_ROOT = join(__dirname, "..", "..", "..");
const DESIGN_MD = readFileSync(join(REPO_ROOT, "docs", "design", "DESIGN.md"), "utf-8");
const GLOBALS_CSS = readFileSync(join(__dirname, "..", "src", "app", "globals.css"), "utf-8");

/**
 * Parses a Markdown table that follows a heading whose text matches
 * `heading` exactly (any heading depth). Returns the data rows as
 * arrays of cell strings (header and separator rows excluded).
 *
 * The scanner:
 *   1. Finds the line `^#+\s+<heading>\s*$`.
 *   2. Skips lines until one starts with `|` (the header row).
 *   3. Skips the header row and the next line (the separator).
 *   4. Collects subsequent lines starting with `|` as data rows,
 *      splitting on `|` and trimming each cell; the outer empty
 *      cells (from leading/trailing pipes) are dropped.
 *   5. Stops at the first non-`|` line.
 */
function parseMarkdownTable(md: string, heading: string): string[][] {
  const lines = md.split("\n");
  let i = 0;
  for (; i < lines.length; i++) {
    const match = lines[i].match(/^#+\s+(.+?)\s*$/);
    if (match && match[1] === heading) break;
  }
  if (i === lines.length) {
    throw new Error(`Heading not found: "${heading}"`);
  }
  for (; i < lines.length; i++) {
    if (lines[i].startsWith("|")) break;
  }
  if (i === lines.length) {
    throw new Error(`Table not found under heading: "${heading}"`);
  }
  i += 2; // skip header row + separator row
  const rows: string[][] = [];
  for (; i < lines.length; i++) {
    if (!lines[i].startsWith("|")) break;
    // DESIGN.md tables wrap most cell values in `backticks` for
    // inline-code rendering. Strip a single leading and/or trailing
    // backtick from each cell so the bare value is what the test sees.
    const cells = lines[i].split("|").map((c) => c.trim().replace(/^`|`$/g, ""));
    cells.shift(); // drop leading empty cell from outer pipe
    cells.pop(); // drop trailing empty cell from outer pipe
    rows.push(cells);
  }
  return rows;
}

/**
 * Parses a Tailwind 4 `@theme { ... }` block from CSS. Returns a map
 * of CSS variable names (with leading `--`) to their declared values,
 * trimmed. Block comments are stripped. Nested blocks are not
 * supported (the @theme block in globals.css is single-level).
 */
function parseThemeBlock(css: string): Record<string, string> {
  const match = css.match(/@theme\s*\{([\s\S]*?)\n\}/);
  if (!match) {
    throw new Error("No `@theme { ... }` block found in globals.css");
  }
  const body = match[1];
  const stripped = body.replace(/\/\*[\s\S]*?\*\//g, "");
  const decls: Record<string, string> = {};
  for (const part of stripped.split(";")) {
    const line = part.trim();
    if (!line) continue;
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    const prop = line.slice(0, colon).trim();
    const val = line.slice(colon + 1).trim();
    if (prop.startsWith("--")) decls[prop] = val;
  }
  return decls;
}

/**
 * Converts a DESIGN.md semantic token name (e.g. "color.surface.canvas")
 * to the corresponding Tailwind 4 `@theme` CSS variable name
 * (e.g. "--color-surface-canvas"). The conversion is: prefix `--`,
 * then replace all `.` with `-`. DESIGN.md tokens use dot-separated
 * namespacing; CSS variables use dash-separated naming.
 */
function tokenToCssVar(token: string): string {
  return "--" + token.replace(/\./g, "-");
}

describe("DESIGN.md ↔ globals.css design-token drift", () => {
  test("color tokens declared in @theme match DESIGN.md hex values", () => {
    const colorRows = parseMarkdownTable(DESIGN_MD, "Color tokens");
    const theme = parseThemeBlock(GLOBALS_CSS);

    expect(
      colorRows.length,
      "DESIGN.md Color tokens table should have at least one row",
    ).toBeGreaterThan(0);

    for (const row of colorRows) {
      // Row shape per DESIGN.md: [token, tailwindValue, hex, usage]
      const [token, , hex] = row;
      const cssVar = tokenToCssVar(token);
      expect(
        theme[cssVar],
        `DESIGN.md says ${token} = ${hex}; globals.css @theme should declare ${cssVar}: ${hex};`,
      ).toBe(hex);
    }
  });
});
