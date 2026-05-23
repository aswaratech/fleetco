import {
  Body,
  Controller,
  DefaultValuePipe,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
  Req,
  ParseIntPipe,
  UseGuards,
} from "@nestjs/common";
import type { Vehicle } from "@prisma/client";

import { AuthGuard } from "../auth/auth.guard";
import type { AuthenticatedRequest } from "../auth/auth.types";

// VehiclesService is injected by NestJS via emitDecoratorMetadata; the
// class reference must remain a value import at runtime. See the matching
// comment in health.service.ts for the rationale.
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { VehiclesService, DEFAULT_TAKE } from "./vehicles.service";
import {
  CreateVehicleSchema,
  UpdateVehicleSchema,
  type CreateVehicleInput,
  type UpdateVehicleInput,
} from "./vehicles.schemas";
import { ZodValidationPipe } from "./zod-validation.pipe";

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

  /**
   * Create a Vehicle. The body is validated by ZodValidationPipe against
   * CreateVehicleSchema (vehicles.schemas.ts); malformed payloads return
   * HTTP 400 with a clear, per-field message. createdById comes from the
   * authenticated session (AuthGuard populates request.session); it is
   * never read from the body — the schema's `.strict()` rejects it.
   * Duplicate registrationNumber surfaces as HTTP 409 (mapped in the
   * service from Prisma's P2002 error code).
   */
  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(
    @Body(new ZodValidationPipe(CreateVehicleSchema)) body: CreateVehicleInput,
    @Req() request: AuthenticatedRequest,
  ): Promise<Vehicle> {
    return this.vehicles.create(body, request.session.user.id);
  }

  /**
   * Partial update. UpdateVehicleSchema enforces "at least one field"
   * and rejects unknown keys (so a client cannot smuggle `id` or
   * `createdById` through this endpoint). 404 on missing record;
   * 409 on registrationNumber conflict (service maps P2002).
   */
  @Patch(":id")
  async update(
    @Param("id") id: string,
    @Body(new ZodValidationPipe(UpdateVehicleSchema)) body: UpdateVehicleInput,
  ): Promise<Vehicle> {
    const updated = await this.vehicles.update(id, body);
    if (!updated) {
      throw new NotFoundException(`Vehicle ${id} not found`);
    }
    return updated;
  }

  /**
   * Hard delete. Returns HTTP 204 (no body) on success; 404 when the
   * vehicle does not exist (the service returns false for P2025).
   *
   * Future slice (Trips) will likely change this to either a soft delete
   * or a block-when-referenced check, because once Trips reference
   * Vehicle by id, hard-deleting a Vehicle that has Trips would either
   * orphan the Trips (data loss) or fail at the DB layer (foreign-key
   * Restrict, surfacing as Prisma P2003 — which we would then map to
   * HTTP 409 the same way P2002 is mapped today). The service-layer
   * comment on `delete` records this same plan; this controller-side
   * note exists so a future reader scanning the public surface for
   * "what happens when I DELETE a vehicle that has trips" finds the
   * answer here without needing to open the service.
   */
  @Delete(":id")
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(@Param("id") id: string): Promise<void> {
    const deleted = await this.vehicles.delete(id);
    if (!deleted) {
      throw new NotFoundException(`Vehicle ${id} not found`);
    }
  }
}
