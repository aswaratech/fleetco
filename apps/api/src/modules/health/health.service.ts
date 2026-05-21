import { Injectable } from "@nestjs/common";

// PrismaService and RedisService are injected by NestJS via TypeScript's
// emitDecoratorMetadata (see apps/api/tsconfig.json); the class references
// must remain as value imports at runtime so the DI container can resolve
// them. typescript-eslint's consistent-type-imports rule does not detect
// decorator-metadata usage and would silently break DI by converting
// these to `import type`.
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { PrismaService } from "../prisma/prisma.service";
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { RedisService } from "../redis/redis.service";

export type ProbeStatus = "up" | "down";

@Injectable()
export class HealthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  async pingDatabase(): Promise<ProbeStatus> {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      return "up";
    } catch {
      return "down";
    }
  }

  async pingRedis(): Promise<ProbeStatus> {
    try {
      const result = await this.redis.ping();
      return result === "PONG" ? "up" : "down";
    } catch {
      return "down";
    }
  }
}
