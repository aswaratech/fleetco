// The wrapper→module re-validation bridge (ADR-0043 c2, ticket A4).
//
// The module `List*QuerySchema`s expect HTTP-query-shaped input — every field
// a string, csv for multi-value enum filters, string integers for skip/take —
// because Express hands controllers strings. The agent wrappers, by contrast,
// validate TYPED values (real arrays, real numbers) because that is what an
// LLM emits against a JSON schema. This helper converts validated wrapper
// output back into the query shape, so every list tool can run the owning
// module's REAL `.strict()` schema as its second, authoritative validation
// pass:
//
//   const query = ListVehiclesQuerySchema.parse(toQueryShape(args));
//   return vehicles.list(query);
//
// One uniform rule covers all nine list surfaces (verified per-surface at A4
// design time): drop undefined, join arrays with commas (csvEnum), String()
// everything else (intParam / CuidFilter / z.coerce.date all accept strings).

/**
 * Convert a validated wrapper-args object into the HTTP-query shape the
 * module list schemas expect. Accepts `unknown` (the ToolDefinition.execute
 * contract) and asserts objectness so tool files need no casts.
 */
export function toQueryShape(args: unknown): Record<string, string> {
  if (typeof args !== "object" || args === null || Array.isArray(args)) {
    // Unreachable through the registry (the wrapper schemas are .strict()
    // objects); guards a direct mis-call loudly instead of silently.
    throw new TypeError("toQueryShape expects a plain object of wrapper args");
  }
  const query: Record<string, string> = {};
  for (const [key, value] of Object.entries(args)) {
    if (value === undefined) continue;
    query[key] = Array.isArray(value) ? value.join(",") : String(value);
  }
  return query;
}
