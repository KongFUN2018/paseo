import { z } from "zod";
import { AgentProviderSchema } from "../provider-manifest.js";
import { RoomRecordSchema, RoomSummarySchema } from "./types.js";

const RoomMemberInputSchema = z.object({
  provider: AgentProviderSchema,
  model: z.string().trim().min(1).nullable().optional(),
  modeId: z.string().trim().min(1).nullable().optional(),
  persona: z.string(),
  // COMPAT(roomRefactor): added in v0.14.0, remove after 2027-04-24 once daemon floor >= v0.14.0.
  displayName: z.string().trim().min(1).optional(),
  // COMPAT(roomRefactor): added in v0.14.0, remove after 2027-04-24 once daemon floor >= v0.14.0.
  roleId: z.string().trim().min(1).optional(),
});

const RoomModeratorInputSchema = z.object({
  provider: AgentProviderSchema,
  model: z.string().trim().min(1).nullable().optional(),
  modeId: z.string().trim().min(1).nullable().optional(),
});

const RoomLimitsInputSchema = z.object({
  maxRounds: z.number().int().positive().optional(),
  maxTurns: z.number().int().positive().optional(),
  turnTimeoutMs: z.number().int().positive().optional(),
  deltaCharBudget: z.number().int().positive().optional(),
});

export const RoomCreateRequestSchema = z.object({
  type: z.literal("room.create.request"),
  requestId: z.string(),
  workspaceId: z.string().min(1),
  name: z.string().min(1),
  topic: z.string(),
  moderator: RoomModeratorInputSchema,
  members: z.array(RoomMemberInputSchema).min(2).max(4),
  artifactPath: z.string().min(1),
  limits: RoomLimitsInputSchema.optional(),
});

export const RoomListRequestSchema = z.object({
  type: z.literal("room.list.request"),
  requestId: z.string(),
});

export const RoomGetRequestSchema = z.object({
  type: z.literal("room.get.request"),
  requestId: z.string(),
  roomId: z.string().min(1),
});

export const RoomStartRequestSchema = z.object({
  type: z.literal("room.start.request"),
  requestId: z.string(),
  roomId: z.string().min(1),
  resume: z.boolean().optional(),
});

export const RoomPauseRequestSchema = z.object({
  type: z.literal("room.pause.request"),
  requestId: z.string(),
  roomId: z.string().min(1),
});

export const RoomResumeRequestSchema = z.object({
  type: z.literal("room.resume.request"),
  requestId: z.string(),
  roomId: z.string().min(1),
});

export const RoomInterjectRequestSchema = z.object({
  type: z.literal("room.interject.request"),
  requestId: z.string(),
  roomId: z.string().min(1),
  text: z.string().min(1),
});

export const RoomCloseRequestSchema = z.object({
  type: z.literal("room.close.request"),
  requestId: z.string(),
  roomId: z.string().min(1),
});

export const RoomReopenRequestSchema = z.object({
  type: z.literal("room.reopen.request"),
  requestId: z.string(),
  roomId: z.string().min(1),
});

export const RoomCreateResponseSchema = z.object({
  type: z.literal("room.create.response"),
  payload: z.object({
    requestId: z.string(),
    roomId: z.string().nullable(),
    error: z.string().nullable(),
  }),
});

export const RoomListResponseSchema = z.object({
  type: z.literal("room.list.response"),
  payload: z.object({
    requestId: z.string(),
    rooms: z.array(RoomSummarySchema),
    error: z.string().nullable(),
  }),
});

export const RoomGetResponseSchema = z.object({
  type: z.literal("room.get.response"),
  payload: z.object({
    requestId: z.string(),
    room: RoomRecordSchema.nullable(),
    truncated: z.boolean().optional(),
    error: z.string().nullable(),
  }),
});

const RoomMutationPayloadSchema = z.object({
  requestId: z.string(),
  room: RoomRecordSchema.nullable(),
  error: z.string().nullable(),
});

export const RoomStartResponseSchema = z.object({
  type: z.literal("room.start.response"),
  payload: RoomMutationPayloadSchema,
});

export const RoomPauseResponseSchema = z.object({
  type: z.literal("room.pause.response"),
  payload: RoomMutationPayloadSchema,
});

export const RoomResumeResponseSchema = z.object({
  type: z.literal("room.resume.response"),
  payload: RoomMutationPayloadSchema,
});

export const RoomInterjectResponseSchema = z.object({
  type: z.literal("room.interject.response"),
  payload: RoomMutationPayloadSchema,
});

export const RoomCloseResponseSchema = z.object({
  type: z.literal("room.close.response"),
  payload: RoomMutationPayloadSchema,
});

export const RoomReopenResponseSchema = z.object({
  type: z.literal("room.reopen.response"),
  payload: RoomMutationPayloadSchema,
});

export const RoomUpdateMessageSchema = z.object({
  type: z.literal("room_update"),
  payload: z.object({
    room: RoomRecordSchema,
    // True when the transcript was truncated for the wire (design §8.3).
    truncated: z.boolean().optional(),
  }),
});

// COMPAT(roomRefactor): added in v0.14.0, remove after 2027-04-24 once daemon floor >= v0.14.0.
export const RoomMemberAddRequestSchema = z.object({
  type: z.literal("room.member.add.request"),
  requestId: z.string(),
  roomId: z.string().min(1),
  member: RoomMemberInputSchema,
});

// COMPAT(roomRefactor): added in v0.14.0, remove after 2027-04-24 once daemon floor >= v0.14.0.
export const RoomMemberAddResponseSchema = z.object({
  type: z.literal("room.member.add.response"),
  payload: RoomMutationPayloadSchema,
});

// COMPAT(roomRefactor): added in v0.14.0, remove after 2027-04-24 once daemon floor >= v0.14.0.
export const RoomFilesListRequestSchema = z.object({
  type: z.literal("room.files.list.request"),
  requestId: z.string(),
  roomId: z.string().min(1),
});

// COMPAT(roomRefactor): added in v0.14.0, remove after 2027-04-24 once daemon floor >= v0.14.0.
export const RoomFilesListResponseSchema = z.object({
  type: z.literal("room.files.list.response"),
  payload: z.object({
    requestId: z.string(),
    error: z.string().nullable(),
    files: z.array(
      z.object({
        // Workspace-relative path; memberId null means the moderator summary or a root file.
        path: z.string(),
        memberId: z.string().nullable(),
        sizeBytes: z.number(),
        updatedAtMs: z.number(),
      }),
    ),
  }),
});

// COMPAT(roomRefactor): added in v0.14.0, remove after 2027-04-24 once daemon floor >= v0.14.0.
export const RoomPartialUpdateMessageSchema = z.object({
  type: z.literal("room_partial_update"),
  payload: z.object({
    roomId: z.string().min(1),
    memberId: z.string().min(1),
    // Accumulated snapshot of the in-progress statement, NOT a delta.
    text: z.string(),
    toolCalls: z.number().int().nonnegative(),
    // True exactly once at the terminal flush (completed/failed/canceled).
    done: z.boolean(),
  }),
});
