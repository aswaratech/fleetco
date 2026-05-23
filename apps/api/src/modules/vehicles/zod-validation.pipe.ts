import { BadRequestException, type PipeTransform } from "@nestjs/common";
import { ZodError, type ZodType } from "zod";

// Small reusable pipe that validates a request body (or any payload)
// against a Zod schema and surfaces failures as HTTP 400. Lives in the
// vehicles module because Vehicles is the first slice to need it; if a
// second module needs it the file moves to a shared place (likely
// apps/api/src/common/zod-validation.pipe.ts) and the import path is
// the only change.
//
// The kickoff for iter 2 explicitly directs zod usage over adding a new
// validator library: zod is already a top-level API dependency. A pipe
// is the idiomatic NestJS hook for "transform-or-reject" semantics on a
// controller argument; it integrates cleanly with @Body() decorators
// and is locally scoped per route rather than globally registered.
export class ZodValidationPipe<T> implements PipeTransform<unknown, T> {
  constructor(private readonly schema: ZodType<T>) {}

  transform(value: unknown): T {
    try {
      return this.schema.parse(value);
    } catch (error) {
      if (error instanceof ZodError) {
        // Compact the first issue (or all issues) into a single human
        // message. The convention across the API is "field: explanation"
        // joined by "; ". This keeps error responses cheap to parse on
        // the web client side (the form shows the message inline) and
        // legible in API logs (the message is the same string a curl
        // user sees).
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
