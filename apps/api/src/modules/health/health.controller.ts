import { Controller, Get, ServiceUnavailableException } from "@nestjs/common";

// HealthService is injected by NestJS via emitDecoratorMetadata; the class
// reference must remain a value import at runtime. See the matching
// comment in health.service.ts for the rationale.
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { HealthService, type ProbeStatus } from "./health.service";

interface ReadinessBody {
  ok: boolean;
  db: ProbeStatus;
  redis: ProbeStatus;
}

@Controller("health")
export class HealthController {
  constructor(private readonly health: HealthService) {}

  @Get()
  check(): { ok: true } {
    return { ok: true };
  }

  @Get("ready")
  async ready(): Promise<ReadinessBody> {
    const [db, redis] = await Promise.all([this.health.pingDatabase(), this.health.pingRedis()]);
    const ok = db === "up" && redis === "up";
    const body: ReadinessBody = { ok, db, redis };
    if (!ok) {
      throw new ServiceUnavailableException(body);
    }
    return body;
  }
}
