import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Req,
  StreamableFile,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { type AgentAttachment, type AgentConversation } from "@prisma/client";

import { ZodValidationPipe } from "../../common/zod-validation.pipe";
import { AuthGuard } from "../auth/auth.guard";
import { RequirePermission } from "../auth/decorators";
import { RolesGuard } from "../auth/roles.guard";
import { toUserRole } from "../auth/permissions";
import type { Actor } from "../auth/driver-scope.service";
import type { AuthenticatedRequest } from "../auth/auth.types";

// AgentService is injected by NestJS via emitDecoratorMetadata; the class
// reference must remain a value import at runtime so the DI container can
// resolve it. Same pattern every other controller uses for its service.
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import {
  AgentService,
  type AgentActionWithUser,
  type AgentTranscript,
  type AgentTurnResult,
} from "./agent.service";
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import {
  AgentAttachmentsService,
  MAX_ATTACHMENT_BYTES,
  type UploadedImageFile,
} from "./agent-attachments.service";
import {
  ListAgentActionsQuerySchema,
  ListAgentConversationsQuerySchema,
  PostAgentTurnSchema,
  type AgentActionSortColumn,
  type AgentActionSortDir,
  type ListAgentActionsQuery,
  type ListAgentConversationsQuery,
  type PostAgentTurnInput,
} from "./agent.schemas";

/** Default page size for the conversation rail. */
export const CONVERSATIONS_LIST_TAKE_DEFAULT = 50;

/** Default page size for the activity ledger (DESIGN.md §"Agent activity"). */
export const ACTIONS_LIST_TAKE_DEFAULT = 20;

export interface AgentConversationsListResponse {
  items: AgentConversation[];
  total: number;
  skip: number;
  take: number;
}

export interface AgentActionsListResponse {
  items: AgentActionWithUser[];
  total: number;
  skip: number;
  take: number;
  sortBy: AgentActionSortColumn;
  sortDir: AgentActionSortDir;
}

// The AI chat agent's HTTP surface (ADR-0043 c4/c5/c7, tickets A5/A8). Five
// routes: create / list conversations, read one transcript, POST a turn
// (the synchronous request/response the c7 UI consumes — no streaming in
// v1), and the A8 activity ledger.
//
// Guards at the CONTROLLER level — `@UseGuards(AuthGuard, RolesGuard)` in
// that order (401 for anonymous, then 403 for authenticated-but-
// unauthorized) — with a single CLASS-level `@RequirePermission("agent:use")`
// rather than the invoices/trackers per-route split: every agent route
// carries the SAME privilege (talking to the agent), so there is no
// read/write split to express. `agent:use` is ADMIN-only in v1 (ADR-0043 c1);
// widening to OFFICE_STAFF is a permissions.ts row, not a controller edit.
//
// Within the gate, everything is additionally scoped to the ACTING user's own
// conversations by the service (a second admin would not see this admin's
// chats); the cross-user audit surface is A8's /agent/activity page, which
// reads AgentAction rows, not transcripts.
@Controller("api/v1/agent")
@UseGuards(AuthGuard, RolesGuard)
@RequirePermission("agent:use")
export class AgentController {
  constructor(
    private readonly agent: AgentService,
    private readonly attachments: AgentAttachmentsService,
  ) {}

  // Build the acting principal from the session, with the role coerced
  // through `toUserRole` (the single fail-closed coercion the guards and /me
  // share). The actor is BOTH the conversation owner and the identity every
  // tool executes as (ADR-0043 c1 / ADR-0021: the requesting human, never a
  // synthetic machine actor).
  private actorOf(request: AuthenticatedRequest): Actor {
    return {
      userId: request.session.user.id,
      role: toUserRole(request.session.user.role),
    };
  }

  /** Open a new, empty conversation (the title arrives with the first turn). */
  @Post("conversations")
  @HttpCode(HttpStatus.CREATED)
  async createConversation(@Req() request: AuthenticatedRequest): Promise<AgentConversation> {
    return this.agent.createConversation(this.actorOf(request));
  }

  /** List the acting user's own conversations, most recently active first. */
  @Get("conversations")
  async listConversations(
    @Query(new ZodValidationPipe(ListAgentConversationsQuerySchema))
    query: ListAgentConversationsQuery,
    @Req() request: AuthenticatedRequest,
  ): Promise<AgentConversationsListResponse> {
    const skip = query.skip ?? 0;
    const take = query.take ?? CONVERSATIONS_LIST_TAKE_DEFAULT;
    const { items, total } = await this.agent.listConversations(this.actorOf(request), {
      skip,
      take,
    });
    return { items, total, skip, take };
  }

  /**
   * The activity ledger (ticket A8, DESIGN.md §"Agent activity"): AgentAction
   * rows across ALL users, filterable by tool/status/date range. Rides the
   * class-level `agent:use` gate — no second token while the gate's audience
   * (ADMIN) is identical; the recorded caveat: if agent:use is ever granted
   * to OFFICE_STAFF, this CROSS-USER view widens with it — mint a dedicated
   * audit token at that moment. Items carry argsJson and previousJson (Tier 2
   * over the wire to the authorized ADMIN — the transcript endpoint already
   * ships argsJson; previousJson makes the runbook's undo procedure readable
   * from the UI instead of psql).
   */
  @Get("actions")
  async listActions(
    @Query(new ZodValidationPipe(ListAgentActionsQuerySchema)) query: ListAgentActionsQuery,
  ): Promise<AgentActionsListResponse> {
    const skip = query.skip ?? 0;
    const take = query.take ?? ACTIONS_LIST_TAKE_DEFAULT;
    const sortBy: AgentActionSortColumn = query.sortBy ?? "createdAt";
    const sortDir: AgentActionSortDir = query.sortDir ?? "desc";
    const { items, total } = await this.agent.listActions({
      toolName: query.toolName,
      status: query.status,
      startDate: query.startDate,
      endDate: query.endDate,
      sortDir,
      skip,
      take,
    });
    return { items, total, skip, take, sortBy, sortDir };
  }

  /**
   * The full stored transcript (messages + action rows in insertion order).
   * 404 for a missing conversation and equally for another user's (Tier-2
   * content: existence is not leaked).
   */
  @Get("conversations/:id")
  async getTranscript(
    @Param("id") id: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<AgentTranscript> {
    return this.agent.getTranscript(id, this.actorOf(request));
  }

  /**
   * Run one turn: persist the user message, drive the tool loop, return
   * everything the turn produced (messages + AgentAction rows — the
   * server-derived action-card source, c4c). Synchronous by design (c7):
   * the response arrives when the loop ends, bounded by the 90 s turn wall
   * clock, which nests inside the web server action's ~150 s budget. 409
   * when a turn is already in flight for this conversation (c4d).
   */
  @Post("conversations/:id/turns")
  @HttpCode(HttpStatus.OK)
  async postTurn(
    @Param("id") id: string,
    @Body(new ZodValidationPipe(PostAgentTurnSchema)) body: PostAgentTurnInput,
    @Req() request: AuthenticatedRequest,
  ): Promise<AgentTurnResult> {
    return this.agent.runTurn(id, body.content ?? "", this.actorOf(request), body.attachmentId);
  }

  /**
   * Upload one image against the acting user's own conversation (ADR-0044
   * c3, ticket V4). Multipart with a single `file` part; multer keeps the
   * bytes in memory (the default when no storage is configured) and rejects
   * streams past 10 MB with 413 before they buffer — the service then sniffs
   * magic bytes (never trusting the client's content type), stores through
   * the ObjectStorage seam, and rows the attachment unclaimed (messageId
   * null) until a turn claims it (V7). NOTE: `main.ts` disables Nest's
   * default body parser and re-attaches json/urlencoded only — multipart
   * passes through untouched for multer to consume (pinned by the V4
   * endpoint test).
   */
  @Post("conversations/:id/attachments")
  @HttpCode(HttpStatus.CREATED)
  @UseInterceptors(FileInterceptor("file", { limits: { fileSize: MAX_ATTACHMENT_BYTES } }))
  async uploadAttachment(
    @Param("id") id: string,
    @UploadedFile() file: UploadedImageFile | undefined,
    @Req() request: AuthenticatedRequest,
  ): Promise<AgentAttachment> {
    if (file === undefined) {
      throw new BadRequestException('A multipart file part named "file" is required.');
    }
    return this.attachments.upload(id, file, this.actorOf(request));
  }

  /**
   * Stream an attachment's bytes back to its OWNER, inline (the transcript
   * thumbnail / full view; the web reaches this through its authed proxy
   * route — attachment bytes are Tier-2-handled and never get a public URL).
   * Two-segment route, so it never shadows the `conversations/:id` read.
   */
  @Get("attachments/:id")
  async getAttachment(
    @Param("id") id: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<StreamableFile> {
    const { buffer, contentType } = await this.attachments.getBytes(id, this.actorOf(request));
    return new StreamableFile(buffer, { type: contentType, disposition: "inline" });
  }
}
