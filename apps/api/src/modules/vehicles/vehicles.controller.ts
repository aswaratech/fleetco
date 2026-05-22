import {
  Controller,
  DefaultValuePipe,
  Get,
  NotFoundException,
  Param,
  ParseIntPipe,
  Query,
  UseGuards,
} from "@nestjs/common";
import type { Vehicle } from "@prisma/client";

import { AuthGuard } from "../auth/auth.guard";

// VehiclesService is injected by NestJS via emitDecoratorMetadata; the
// class reference must remain a value import at runtime. See the matching
// comment in health.service.ts for the rationale.
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { VehiclesService, DEFAULT_TAKE } from "./vehicles.service";

export interface VehiclesListResponse {
  items: Vehicle[];
  total: number;
  skip: number;
  take: number;
}

// Route prefix: `api/v1/vehicles`. The existing AuthController uses no
// prefix (mounted at /me) and HealthController uses /health; a global
// prefix would break those and the better-auth handler at /auth/{*splat}.
// Versioning at the controller level keeps the API surface explicit and
// future-proofs the URL space without coupling unrelated controllers
// to the same prefix.
@Controller("api/v1/vehicles")
@UseGuards(AuthGuard)
export class VehiclesController {
  constructor(private readonly vehicles: VehiclesService) {}

  @Get()
  async list(
    @Query("skip", new DefaultValuePipe(0), ParseIntPipe) skip: number,
    @Query("take", new DefaultValuePipe(DEFAULT_TAKE), ParseIntPipe) take: number,
  ): Promise<VehiclesListResponse> {
    const { items, total } = await this.vehicles.list({ skip, take });
    return { items, total, skip, take };
  }

  @Get(":id")
  async getById(@Param("id") id: string): Promise<Vehicle> {
    const vehicle = await this.vehicles.getById(id);
    if (!vehicle) {
      throw new NotFoundException(`Vehicle ${id} not found`);
    }
    return vehicle;
  }
}
