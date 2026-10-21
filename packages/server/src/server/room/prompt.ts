import type { RoomLimits, RoomMember, RoomRecord } from "@getpaseo/protocol/room/types";
import type { ModeratorAction } from "./scheduler.js";

const TRUNCATION_MARKER = "（更早内容已截断）";
const NO_DELTA_MARKER = "（你还没有发过言）";
const DEFAULT_MODERATOR_NOTE = "继续原顺序";

export interface ModeratorOpening {
  opening: string;
  nextMemberId: string | null;
}

export interface ModeratorDecision {
  action: ModeratorAction;
  nextMemberId: string | null;
  reason: string;
  userReply: string | null;
}

/**
 * Prompt assembly for rooms (design §7). All templates carry stable markers so
 * scripted test providers can recognize their cue without parsing prose.
 */
export function buildModeratorSystemPrompt(input: {
  workspaceDirectory: string;
  roomName: string;
  members: RoomMember[];
}): string {
  const memberLines = input.members
    .map(
      (member) =>
        `- ${member.id}: ${member.provider} / ${member.model ?? "default"}: ${member.persona}`,
    )
    .join("\n");
  return [
    "You are the moderator of a multi-model chat room. You do not take part in the discussion.",
    "You do three jobs: open the round, decide the next step at checkpoints, and write the final summary.",
    `Workspace directory: ${input.workspaceDirectory}`,
    `Room: ${input.roomName}`,
    "Members:",
    memberLines,
    "Rules:",
    "- Reply with a single JSON object and nothing else.",
    "- action is one of: continue, reorder, skip, finish, answer_user.",
    "- finish is only valid at a round-end checkpoint.",
    "- When unsure, choose continue.",
    "- Never speak for a member.",
  ].join("\n");
}

export function buildMemberSystemPrompt(input: { roomName: string; member: RoomMember }): string {
  return [
    `You are member ${input.member.id} of the chat room ${input.roomName}.`,
    `Your role: ${input.member.persona}`,
    "Reply only with the body of your statement. Do not restate the task, mention prompts, or impersonate other members.",
  ].join("\n");
}

export function buildOpeningPrompt(topic: string): string {
  return [
    "User task:",
    topic,
    "",
    'Reply with JSON: {"opening":"...","action":"continue","nextMemberId":"member_x"}',
    "opening states the goal and the member roles in at most 120 words.",
  ].join("\n");
}

export function buildCheckpointPrompt(input: {
  round: number;
  turnCount: number;
  recentTranscript: string;
  pendingInterjections: string;
}): string {
  return [
    `Progress: round ${input.round}, ${input.turnCount} completed turns.`,
    "Recent statements (oldest first):",
    input.recentTranscript,
    "Pending user interjections:",
    input.pendingInterjections,
    "Decide the next step. Reply with JSON:",
    '{"action":"continue|reorder|skip|finish|answer_user","nextMemberId":"member_x|null","reason":"...","userReply":"..."}',
  ].join("\n");
}

export function buildSummaryPrompt(): string {
  return [
    "The discussion reached its closing condition. Write the conclusion:",
    "- Conclusion first, then the key disagreements and open questions.",
    "- At most 800 words.",
    "- Reply with the Markdown body only, no JSON.",
  ].join("\n");
}

export function buildMemberTurnPrompt(input: {
  record: RoomRecord;
  member: RoomMember;
  moderatorNote: string | null;
  retryReason: string | null;
}): string {
  const delta = collectDelta(input.record, input.member, input.record.limits);
  return [
    `[round ${input.record.round.index} | turn ${input.record.turn.index}]`,
    "",
    "User task:",
    input.record.topic,
    "",
    "New statements from other members since you last spoke:",
    delta,
    "",
    `Moderator note: ${input.moderatorNote ?? DEFAULT_MODERATOR_NOTE}`,
    ...(input.retryReason
      ? [`Your previous attempt failed (${input.retryReason}); try again.`]
      : []),
    "",
    "Give your statement for this round.",
  ].join("\n");
}

/** Statements the member has not seen yet, oldest first, truncated to the char budget. */
export function collectDelta(record: RoomRecord, member: RoomMember, limits: RoomLimits): string {
  const lines: string[] = [];
  for (const entry of record.transcript) {
    if (entry.seq <= member.lastDeliveredSeq) continue;
    if (entry.kind === "member" && entry.memberId === member.id) continue;
    const speaker = entry.kind === "member" ? (entry.memberId ?? "member") : entry.kind;
    lines.push(`- ${speaker}: ${entry.text}`);
  }
  if (lines.length === 0) return NO_DELTA_MARKER;
  let text = lines.join("\n");
  if (text.length > limits.deltaCharBudget) {
    text = `${TRUNCATION_MARKER}\n${text.slice(text.length - limits.deltaCharBudget)}`;
  }
  return text;
}

function extractJson(text: string): Record<string, unknown> | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    const parsed: unknown = JSON.parse(text.slice(start, end + 1));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/** Opening reply parser; null means the deterministic fallback should be used. */
export function parseModeratorOpening(text: string): ModeratorOpening | null {
  const json = extractJson(text);
  const opening = readString(json?.opening);
  if (!opening) return null;
  const nextMemberId = readString(json?.nextMemberId);
  return { opening, nextMemberId };
}

/** Checkpoint reply parser; null falls back to `continue` (design §3.4). */
export function parseModeratorDecision(text: string): ModeratorDecision | null {
  const json = extractJson(text);
  const action = readString(json?.action);
  if (!action) return null;
  if (!["continue", "reorder", "skip", "finish", "answer_user"].includes(action)) return null;
  return {
    action: action as ModeratorAction,
    nextMemberId: readString(json?.nextMemberId),
    reason: readString(json?.reason) ?? "",
    userReply: readString(json?.userReply),
  };
}

/** Last-resort opening when the moderator reply is unusable. */
export function fallbackOpening(text: string): ModeratorOpening {
  const trimmed = text.trim();
  return {
    opening: trimmed.length > 0 ? trimmed.slice(0, 400) : "（主持人开场不可用，按默认顺序开始。）",
    nextMemberId: null,
  };
}
