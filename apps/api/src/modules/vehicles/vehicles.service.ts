import { Injectable } from "@nestjs/common";
import type { Prisma, Vehicle } from "@prisma/client";

// PrismaService is injected by NestJS via TypeScript's emitDecoratorMetadata
// (see apps/api/tsconfig.json); the class reference must remain a value
// import at runtime so the DI container can resolve it.
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { PrismaService } from "../prisma/prisma.service";

export interface ListResult {
  items: Vehicle[];
  total: number;
}

// Pagination defaults and bounds. The take cap (200) protects the API
// from accidentally large queries while leaving plenty of headroom for
// the admin UI's 50 / 100 page sizes documented in DESIGN.md's Tables
// section. The minimum take (1) prevents the degenerate request that
// returns count-only information through this endpoint; consumers that
// want just a count can read `total` after a default take.
export const DEFAULT_TAKE = 20;
export const MAX_TAKE = 200;
const MIN_TAKE = 1;

@Injectable()
export class VehiclesService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * List vehicles ordered by acquisition date descending (newest first).
   * `skip` and `take` follow Prisma's semantics; both are clamped to safe
   * bounds so a malformed query cannot scan the whole table or return
   * zero rows for non-zero takes. Returns `{ items, total }` so the UI
   * can render pagination without a second round-trip.
   */
  async list({
    skip = 0,
    take = DEFAULT_TAKE,
  }: {
    skip?: number;
    take?: number;
  }): Promise<ListResult> {
    const safeSkip = Number.isFinite(skip) && skip >= 0 ? Math.floor(skip) : 0;
    const safeTakeRaw = Number.isFinite(take) ? Math.floor(take) : DEFAULT_TAKE;
    const safeTake = Math.min(Math.max(safeTakeRaw, MIN_TAKE), MAX_TAKE);

    const args: Prisma.VehicleFindManyArgs = {
      skip: safeSkip,
      take: safeTake,
      orderBy: [{ acquiredAt: "desc" }, { createdAt: "desc" }],
    };

    const [items, total] = await this.prisma.$transaction([
      this.prisma.vehicle.findMany(args),
      this.prisma.vehicle.count(),
    ]);

    return { items, total };
  }

  /**
   * Fetch one vehicle by id. Returns `null` when not found rather than
   * throwing, so the controller can shape the 404 response and the
   * service stays usable from other modules without exception handling
   * for the not-found path.
   */
  async getById(id: string): Promise<Vehicle | null> {
    return this.prisma.vehicle.findUnique({ where: { id } });
  }
}
