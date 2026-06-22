import { describe, expect, test } from "vitest";

import { paginationParams, sortParams } from "../src/lib/list-params";

/**
 * Pins the shared list URL-builders extracted from the 12 list pages. These ran
 * inline and identically on every list surface; the suite locks the contract
 * the shared <Pagination> / <SortableHeader> now depend on: skip is dropped at
 * page 1, a re-sort resets skip, toggling the active column flips direction,
 * unrelated filter params survive, and the input searchParams is never mutated.
 */

describe("paginationParams", () => {
  test("drops skip at page 1 so the canonical URL stays clean", () => {
    expect(paginationParams(new URLSearchParams("status=active&skip=40"), 0)).toBe(
      "?status=active",
    );
  });

  test("sets skip for later pages, preserving other params", () => {
    expect(paginationParams(new URLSearchParams("status=active"), 40)).toBe(
      "?status=active&skip=40",
    );
  });

  test("returns an empty string when no params remain", () => {
    expect(paginationParams(new URLSearchParams(), 0)).toBe("");
  });

  test("does not mutate the input searchParams", () => {
    const sp = new URLSearchParams("skip=20");
    paginationParams(sp, 40);
    expect(sp.get("skip")).toBe("20");
  });
});

describe("sortParams", () => {
  test("toggling the active asc column flips to desc and resets skip", () => {
    const sp = new URLSearchParams("sortBy=name&sortDir=asc&skip=20");
    expect(sortParams(sp, "name", "name", "asc")).toBe("?sortBy=name&sortDir=desc");
  });

  test("toggling the active desc column flips to asc", () => {
    expect(
      sortParams(new URLSearchParams("sortBy=name&sortDir=desc"), "name", "name", "desc"),
    ).toBe("?sortBy=name&sortDir=asc");
  });

  test("selecting a different column sets it descending", () => {
    expect(
      sortParams(new URLSearchParams("sortBy=name&sortDir=asc"), "createdAt", "name", "asc"),
    ).toBe("?sortBy=createdAt&sortDir=desc");
  });

  test("preserves unrelated filter params and clears skip", () => {
    const out = sortParams(
      new URLSearchParams("status=active&sortBy=name&sortDir=asc&skip=40"),
      "createdAt",
      "name",
      "asc",
    );
    const parsed = new URLSearchParams(out.slice(1));
    expect(parsed.get("status")).toBe("active");
    expect(parsed.get("sortBy")).toBe("createdAt");
    expect(parsed.get("sortDir")).toBe("desc");
    expect(parsed.has("skip")).toBe(false);
  });

  test("does not mutate the input searchParams", () => {
    const sp = new URLSearchParams("sortBy=name&sortDir=asc");
    sortParams(sp, "name", "name", "asc");
    expect(sp.get("sortDir")).toBe("asc");
  });
});
