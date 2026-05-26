import { BadRequestException, type PipeTransform } from "@nestjs/common";
import { ZodError, type ZodType } from "zod";

// Small reusable pipe that validates a request body (or any payload)
// against a Zod schema and surfaces failures as HTTP 400. Originally
// lived in the vehicles module because Vehicles was the first slice to
// need it; iter 6 (Drivers read path) is the second consumer, so per
// docs/runbook/api-error-mapping.md §"How to implement the mapping in a
// new module" the file moves here and both modules import from this
// path. The old file at apps/api/src/modules/vehicles/zod-validation.pipe.ts
// re-exports from here for one release so any in-flight branches still
// compile; the next slice that imports it should bring its import path
// in line and the re-export can be deleted.
//
// The kickoff for iter 2 explicitly directs zod usage over adding a new
// validator library: zod is already a top-level API dependency. A pipe
// is the idiomatic NestJS hook for "transform-or-reject" semantics on a
// controller argument; it integrates cleanly with @Body() / @Query()
// decorators and is locally scoped per route rather than globally
// registered.
export class ZodValidationPipe<T> implements PipeTransform<unknown, T> {
  constructor(private readonly schema: ZodType<T>) {}

  transform(value: unknown): T {
    try {
      return this.schema.parse(value);
    } catch (error) {
      if (error instanceof ZodError) {
        // Compact each issue into "field: explanation" and join with
        // "; ". The convention is documented in
        // docs/runbook/api-error-mapping.md so the web client's
        // apps/web/src/lib/api.ts can parse the response body's
        // `message` field as a single string.
        const messages = error.issues.map((issue) => {
          const path = issue.path.length > 0 ? issue.path.join(".") : "body";
          return `${path}: ${issue.message}`;
        });
        throw new BadRequestException({
          statusCode: 400,
          error: "Bad Request",
          message: messages.join("; "),
        });
      }
      // Surface non-Zod errors as-is. This path should never fire in
      // normal operation (only Zod throws ZodError from .parse), but if
      // a schema's refine() throws something exotic we want the
      // original error rather than a silently swallowed 500.
      throw error;
    }
  }
}
