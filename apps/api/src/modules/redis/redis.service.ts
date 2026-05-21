import { Injectable, type OnModuleDestroy } from "@nestjs/common";
import { Redis } from "ioredis";

import { env } from "../../config/env";

@Injectable()
export class RedisService extends Redis implements OnModuleDestroy {
  constructor() {
    super(env.REDIS_URL, {
      // Fail readiness pings fast when Redis is down rather than retrying
      // for many seconds. The default of 20 retries with backoff produces
      // probe timeouts in the tens of seconds, which is wrong for a probe.
      maxRetriesPerRequest: 1,
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.quit();
  }
}
