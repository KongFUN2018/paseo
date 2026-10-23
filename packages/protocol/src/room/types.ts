import { z } from "zod";
import { AgentProviderSchema } from "../provider-manifest.js";

export const ROOM_STATUSES = [
  "forming",
  "opening",
  "discussing",
  "closing",
  "interrupted",
  "closed",
] as const;

export const RoomStatusSchema = z.enum(ROOM_STATUSES);
export type RoomStatus = z.infer<typeof RoomStatusSchema>;

export const RoomMemberStatusSchema = z.enum([
  "pending",
  "ready",
  "speaking",
  "failed",
  "archived",
]);
export type RoomMemberStatus = z.infer<typeof RoomMemberStatusSchema>;

export const RoomTurnStatusSchema = z.enum(["idle", "preparing", "speaking", "retrying"]);
export type RoomTurnStatus = z.infer<typeof RoomTurnStatusSchema>;

export const RoomCheckpointSchema = z.enum(["opening", "round_end", "interjection", "summary"]);
export type RoomCheckpoint = z.infer<typeof RoomCheckpointSchema>;

/** Mirrors `AgentUsage` from agent-types.ts (all fields optional on the wire). */
export const RoomMemberUsageSchema = z.object({
  inputTokens: z.number().optional(),
  cachedInputTokens: z.number().optional(),
  outputTokens: z.number().optional(),
  totalCostUsd: z.number().optional(),
  contextWindowMaxTokens: z.number().optional(),
  contextWindowUsedTokens: z.number().optional(),
});
export type RoomMemberUsage = z.infer<typeof RoomMemberUsageSchema>;

export const RoomMemberSchema = z.object({
  id: z.string().min(1),
  agentId: z.string().nullable(),
  provider: AgentProviderSchema,
  model: z.string().nullable(),
  modeId: z.string().nullable(),
  persona: z.string(),
  status: RoomMemberStatusSchema,
  joinedAt: z.string(),
  lastDeliveredSeq: z.number().int().nonnegative(),
  turnCount: z.number().int().nonnegative(),
  // Last usage snapshot read live from AgentManager; not persisted on disk.
  lastUsage: RoomMemberUsageSchema.optional(),
});
export type RoomMember = z.infer<typeof RoomMemberSchema>;

export const RoomTranscriptEntrySchema = z.object({
  seq: z.number().int().nonnegative(),
  at: z.string(),
  kind: z.enum(["opening", "member", "moderator", "system", "interjection"]),
  memberId: z.string().nullable(),
  agentId: z.string().nullable(),
  text: z.string(),
  turnId: z.string().nullable().optional(),
  interjectionId: z.string().optional(),
});
export type RoomTranscriptEntry = z.infer<typeof RoomTranscriptEntrySchema>;

export const RoomInterjectionSchema = z.object({
  id: z.string().min(1),
  text: z.string(),
  createdAt: z.string(),
  status: z.enum(["queued", "delivered", "answered"]),
  decidedAt: z.string().nullable(),
});
export type RoomInterjection = z.infer<typeof RoomInterjectionSchema>;

export const RoomLimitsSchema = z.object({
  maxRounds: z.number().int().positive(),
  maxTurns: z.number().int().positive(),
  turnTimeoutMs: z.number().int().positive(),
  deltaCharBudget: z.number().int().positive(),
});
export type RoomLimits = z.infer<typeof RoomLimitsSchema>;

export const DEFAULT_ROOM_LIMITS: RoomLimits = {
  maxRounds: 6,
  maxTurns: 24,
  turnTimeoutMs: 900_000,
  deltaCharBudget: 24_000,
};

export const RoomTurnSchema = z.object({
  index: z.number().int().nonnegative(),
  memberId: z.string().nullable(),
  agentId: z.string().nullable(),
  turnId: z.string().nullable(),
  status: RoomTurnStatusSchema,
  startedAt: z.string().nullable(),
  deadlineAt: z.string().nullable(),
  // Number of attempts already made for the current speaker (0 = first attempt).
  attempt: z.number().int().nonnegative(),
});
export type RoomTurn = z.infer<typeof RoomTurnSchema>;

export const RoomRoundSchema = z.object({
  index: z.number().int().positive(),
  remainingMemberIds: z.array(z.string()),
});
export type RoomRound = z.infer<typeof RoomRoundSchema>;

export const RoomModeratorSchema = z.object({
  agentId: z.string().nullable(),
  provider: AgentProviderSchema,
  model: z.string().nullable(),
  modeId: z.string().nullable(),
});
export type RoomModerator = z.infer<typeof RoomModeratorSchema>;

export const RoomRecordSchema = z.object({
  id: z.string().min(1),
  workspaceId: z.string().min(1),
  name: z.string(),
  topic: z.string(),
  status: RoomStatusSchema,
  promptVersion: z.number().int().positive(),
  moderator: RoomModeratorSchema,
  members: z.array(RoomMemberSchema),
  turn: RoomTurnSchema,
  round: RoomRoundSchema,
  transcript: z.array(RoomTranscriptEntrySchema),
  interjections: z.array(RoomInterjectionSchema),
  lastSeq: z.number().int().nonnegative(),
  limits: RoomLimitsSchema,
  artifactPath: z.string(),
  summary: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  closedAt: z.string().nullable(),
  closedReason: z.string().nullable(),
  // Checkpoint the moderator was asked to decide, null when no decision is pending.
  pendingCheckpoint: RoomCheckpointSchema.nullable().optional(),
});
export type RoomRecord = z.infer<typeof RoomRecordSchema>;

export const RoomSummarySchema = RoomRecordSchema.omit({
  transcript: true,
  interjections: true,
});
export type RoomSummary = z.infer<typeof RoomSummarySchema>;
