# API error mapping

> **STATUS: ACTIVE, last verified 2026-05-26.** Introduced in iter 2 of the Vehicles slice (`feat/vehicles-write-path`). This procedure documents the project-wide convention for translating database-layer and validation-layer failures into HTTP status codes. Other modules adopting the write-path pattern follow this mapping rather than inventing their own. As of iter 7 of the Drivers slice, both Vehicles and Drivers write paths use this mapping for `P2002` (duplicate `registrationNumber` / `licenseNumber`) and `P2025` (delete or update of a missing row).

## Why this exists

The Vehicles write path (POST/PATCH/DELETE) was the first surface to hit Prisma's unique-constraint violation in earnest: when a client posts a `registrationNumber` that already exists, Prisma raises `PrismaClientKnownRequestError` with code `P2002`. Without explicit translation, the request returns HTTP 500 — wrong, because the client made a fixable mistake that the server understood. The convention below converts these failures into honest 4xx responses so the client can render an inline message and the user can correct the input without contacting support.

The same translation will apply to every future module that introduces a unique column (Drivers' license number, Customers' PAN, Vendors' registration). Centralizing the mapping here prevents each module from inventing its own response shape.

## The mapping

The following Prisma error codes have agreed translations across the API. Codes not listed propagate unchanged and surface as HTTP 500 via NestJS's default exception filter.

| Prisma code | Meaning | HTTP status | NestJS exception | Notes |
| --- | --- | --- | --- | --- |
| `P2002` | Unique-constraint violation | 409 Conflict | `ConflictException` | Message names the conflicting field (e.g., `A vehicle with registration number "BA 1 KA 1234" already exists.`). Never echo the database column name unless it matches the API field name. |
| `P2003` | Foreign-key constraint failed | 409 Conflict | `ConflictException` | Used for delete-when-referenced (e.g., deleting a vehicle that has trips, once Trips lands). Message names the dependent resource (e.g., `Cannot delete vehicle: 3 trips reference it.`). Mapping not yet exercised in iter 2; will be added when the first cross-aggregate reference exists. |
| `P2025` | Record not found for required relation | 404 Not Found | `NotFoundException` | Raised by `delete()` and `update()` when the target row does not exist. The service-layer convention is to catch this and return `false`/`null` so the controller shapes the 404; this avoids depending on Prisma exception classes outside the service. |

Validation-layer failures (zod) translate to HTTP 400:

| Failure | HTTP status | NestJS exception | Notes |
| --- | --- | --- | --- |
| Zod parse failure on request body | 400 Bad Request | `BadRequestException` | Body is `{ statusCode, error, message }` where `message` is a semicolon-joined list of `<path>: <reason>` entries from `ZodError.issues`. Surfaced by `ZodValidationPipe` (see `apps/api/src/modules/vehicles/zod-validation.pipe.ts`). |

Authentication failures translate via `AuthGuard`:

| Failure | HTTP status | NestJS exception | Notes |
| --- | --- | --- | --- |
| Missing or invalid session cookie | 401 Unauthorized | `UnauthorizedException` | Thrown by `AuthGuard` before the controller runs. The web client treats 401 by redirecting to `/login`. See ADR-0021. |

## How to implement the mapping in a new module

Detection happens at the service layer, not the controller, because the service owns the database call and the controller should remain HTTP-agnostic where possible. The pattern is:

```typescript
import { ConflictException } from "@nestjs/common";
import { Prisma } from "@prisma/client";

try {
  return await this.prisma.<model>.create({ data });
} catch (error) {
  if (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === "P2002"
  ) {
    throw new ConflictException(
      `A <noun> with <field> "<value>" already exists.`,
    );
  }
  throw error;
}
```

For `P2025` (delete-not-found), follow the convention used in `VehiclesService.delete` and `DriversService.delete`: catch the error, return a boolean (or null), and let the controller throw `NotFoundException`. This keeps not-found a normal control-flow path rather than an exception path.

For zod validation, instantiate `ZodValidationPipe` per route with the schema:

```typescript
@Post()
@HttpCode(HttpStatus.CREATED)
async create(
  @Body(new ZodValidationPipe(<Schema>)) body: <Input>,
): Promise<...> { ... }
```

The pipe lives at `apps/api/src/modules/vehicles/zod-validation.pipe.ts` today. When the second module imports it, move the file to `apps/api/src/common/zod-validation.pipe.ts` and update both imports in the same commit.

## Things to verify when changing this mapping

1. **Web client expectations.** `apps/web/src/lib/api.ts` parses the response body's `message` field (string or array of strings). Any change to the response body shape must update that helper.
2. **Logging.** Pino's redact paths (in `apps/api/src/app.module.ts`) cover `*.password`, `*.token`, `*.secret`, `*.email`, `*.driverName`, `*.licenseNumber`, `*.phoneNumber`. Error messages from this mapping must not include those values verbatim; the mapping above is safe because it only echoes API-public identifiers.
3. **Status-code drift.** The mapping table above is the source of truth. If a status code changes (e.g., we switch P2002 to 422 Unprocessable Entity), this file changes in the same commit as the code, and the change is mentioned in the PR description so reviewers see the contract shift.

## Out of scope

This procedure does not specify a global exception filter. NestJS's defaults are sufficient for now: each module catches the specific Prisma codes it cares about and lets unmatched errors propagate to the 500 path. A global filter becomes worth writing only when (a) the same code is being translated in three or more modules with identical messages, (b) cross-cutting observability (Sentry tagging, request-id correlation) needs centralization, or (c) a response-shape change requires a single chokepoint.
