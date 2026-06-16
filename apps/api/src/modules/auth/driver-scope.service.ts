import { ForbiddenException, Injectable } from "@nestjs/common";
import { UserRole } from "@prisma/client";

// PrismaService is injected by NestJS via emitDecoratorMetadata; the class
// reference must remain a value import at runtime so the DI container can
// resolve it. Same eslint override the domain services use.
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { PrismaService } from "../prisma/prisma.service";

// The acting principal for a request, threaded from the controller (which reads
// it off the AuthGuard-populated session) down into the service layer — the same
// way `createdById` is already threaded, NOT a guard change (ADR-0034 c4/c7).
// `userId` is the better-auth User id; `role` is the domain UserRole, which the
// controller coerces from the loose session role via `toUserRole` (permissions.ts)
// before building this — the single fail-closed coercion the whole auth surface
// shares, so the predicate can never disagree with the guard / `/me` on how an
// unexpected role value is treated.
export interface Actor {
  userId: string;
  role: UserRole;
}

// The service-layer own-record scope resolver (ADR-0034 c4). This is the ONE
// place that turns "an authenticated DRIVER" into "their own Driver row", so the
// new enforcement layer ADR-0034 names — every driver-reachable endpoint must
// scope to the driver's own data — has a single, auditable implementation rather
// than a Prisma lookup re-derived (and possibly forgotten) in each service. It
// lives in the auth module because the User↔Driver identity link IS an auth
// concept; it depends only on the @Global PrismaService (the public data seam —
// the ReportsService precedent of reading another aggregate's table through the
// shared client), so it reaches the Driver table without importing another domain
// module's internals (CLAUDE.md "public interfaces only").
@Injectable()
export class DriverScopeService {
  constructor(private readonly prisma: PrismaService) {}

  // Resolve the acting DRIVER's own Driver.id, or null for a non-DRIVER actor.
  //
  //   - non-DRIVER (ADMIN / OFFICE_STAFF): returns null — callers read this as
  //     "no row restriction" and behave exactly as before D2 (zero DB cost; we
  //     return before any query).
  //   - DRIVER with a linked Driver row: returns that Driver.id (one indexed
  //     lookup on Driver.userId @unique). Trip callers scope to `driverId === <this>`;
  //     fuel-log callers scope to `createdById === actor.userId` (the driver's
  //     own entries).
  //   - DRIVER with NO linked Driver row: throws ForbiddenException (403) — FAIL
  //     CLOSED. Every driver login must map to a Driver (ADR-0034 c4's new
  //     invariant); an unlinked DRIVER session must never fall through to an
  //     unscoped result set. A 403 (not 404, not an empty list) makes the
  //     provisioning gap visible rather than silently degrading to "see nothing".
  async resolveOwnDriverId(actor: Actor): Promise<string | null> {
    if (actor.role !== UserRole.DRIVER) {
      return null;
    }
    const driver = await this.prisma.driver.findUnique({
      where: { userId: actor.userId },
      select: { id: true },
    });
    if (!driver) {
      throw new ForbiddenException();
    }
    return driver.id;
  }
}
