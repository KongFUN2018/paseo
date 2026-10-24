import type { RoomLimits, RoomMember, RoomRecord } from "@getpaseo/protocol/room/types";
import type { ModeratorAction } from "./scheduler.js";
import { resolveRolePrompt } from "./role-prompts.js";

const TRUNCATION_MARKER = "（更早内容已截断）";
const NO_DELTA_MARKER = "（你还没有发过言）";
const DEFAULT_MODERATOR_NOTE = "继续原顺序";

/** Room rules verbatim from design §5.1; appended to every v2 member system prompt. */
const ROOM_RULES = [
  "## 聊天室交流守则",
  "1. 一行一句完整的话。",
  "2. 每次发言不超过 5 句，或不超过 300 字。",
  "3. 结论先行：第一句就是你的判断或答案，理由跟在后面。",
  "4. 必须回应：上一条发言或主持人点名与你相关时，先回应，再展开你自己的内容。",
  "5. 不写长报告。长内容写进产出物文件并在发言里给出一句话结论与文件路径。",
  "6. 调研过程不外显：工具调用、中间过程、试错都不要写进发言，只给结论与依据。",
  "7. 点名他人用 @显示名；引用产出物给 workspace 相对路径。",
  "8. 直接说观点，不复述其他成员的发言原文。",
].join("\n");

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
    "Members may join mid-discussion; the checkpoint prompt always carries the authoritative roster.",
    "Member statements follow room rules: one complete sentence per line, at most 5 sentences, conclusion first.",
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

export function buildMemberSystemPrompt(input: {
  promptVersion: number;
  roomName: string;
  member: RoomMember;
  filesDir: string;
}): string {
  if (input.promptVersion < 2) {
    // Legacy rooms keep their original template so reopening an old room does
    // not change its behavior (功能2 §7.1).
    return [
      `You are member ${input.member.id} of the chat room ${input.roomName}.`,
      `Your role: ${input.member.persona}`,
      "Reply only with the body of your statement. Do not restate the task, mention prompts, or impersonate other members.",
    ].join("\n");
  }
  const displayName = input.member.displayName ?? input.member.id;
  return [
    `你是多模型聊天室「${input.roomName}」的成员，名字：${displayName}。`,
    resolveRolePrompt(input.member.roleId, input.member.persona),
    `补充人设：${input.member.persona.length > 0 ? input.member.persona : "（无）"}`,
    `你的产出物目录：${input.filesDir}/${input.member.id}/（workspace 相对路径）。需要沉淀的长内容写在这里，发言里给路径。`,
    "发言语言跟随议题。",
    "",
    ROOM_RULES,
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
  roster: string;
  recentTranscript: string;
  pendingInterjections: string;
}): string {
  return [
    `Progress: round ${input.round}, ${input.turnCount} completed turns.`,
    "Current roster:",
    input.roster,
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
    "- At most 400 Chinese characters, conclusion first.",
    "- Reply with the Markdown body only, no JSON.",
  ].join("\n");
}

export function buildMemberTurnPrompt(input: {
  record: RoomRecord;
  member: RoomMember;
  moderatorNote: string | null;
  retryReason: string | null;
  newFiles: string | null;
}): string {
  const delta = collectDelta(input.record, input.member, input.record.limits);
  if (input.record.promptVersion < 2) {
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
  return [
    `[第 ${input.record.round.index} 轮｜第 ${input.record.turn.index} 个 turn]`,
    "",
    "用户任务：",
    input.record.topic,
    "",
    "自你上次发言后，房间里的新内容：",
    delta,
    ...(input.newFiles ? ["", "新增产出物：", input.newFiles] : []),
    "",
    `主持人指示：${input.moderatorNote ?? DEFAULT_MODERATOR_NOTE}`,
    ...(input.retryReason
      ? [`Your previous attempt failed (${input.retryReason}); try again.`]
      : []),
    "",
    "请发言。遵守守则：结论先行；≤5 句；上一条发言或点名与你相关时先回应；长内容给路径。",
  ].join("\n");
}

/** First-turn prompt for a member that joined mid-room (design §7.5). */
export function buildCatchupTurnPrompt(input: {
  roomName: string;
  topic: string;
  transcriptText: string;
  fileManifest: string;
}): string {
  return [
    `[catch-up｜你刚加入聊天室「${input.roomName}」]`,
    "用户任务：",
    input.topic,
    "",
    "全部历史发言（按时间顺序）：",
    input.transcriptText,
    "",
    "房间产出物（可用你的文件工具读取）：",
    input.fileManifest,
    "",
    "请先用一句话向大家好，说明你已读完记录、你将从什么视角切入。",
    "（该首次发言同样遵守守则：结论先行；≤5 句。）",
  ].join("\n");
}

/** One-shot moderator prompt summarizing history for a late joiner (design §9.4). */
export function buildCatchupSummaryPrompt(transcriptText: string): string {
  return [
    "A new member just joined the room and needs a history digest.",
    "Summarize the discussion so far in at most 400 Chinese characters:",
    "agreed conclusions, open disagreements, and each member's position.",
    "Discussion transcript (oldest first, user interjections marked):",
    transcriptText,
    "Reply with the digest body only.",
  ].join("\n");
}

/**
 * Full transcript with human-readable speaker names for catch-up prompts
 * (design §7.5): displayName replaces member ids, interjections are marked.
 */
export function buildHumanizedTranscript(record: RoomRecord): string {
  return record.transcript
    .map((entry) => {
      let speaker: string;
      switch (entry.kind) {
        case "member": {
          const member = record.members.find((candidate) => candidate.id === entry.memberId);
          speaker = member?.displayName ?? entry.memberId ?? "member";
          break;
        }
        case "interjection":
          speaker = "用户插话";
          break;
        case "opening":
        case "moderator":
          speaker = "主持人";
          break;
        default:
          speaker = "系统";
      }
      return `- ${speaker}: ${entry.text}`;
    })
    .join("\n");
}

/**
 * Authoritative roster for checkpoint prompts (design §9.1): the moderator
 * system prompt is a creation-time snapshot, so mid-room joins only reach it
 * through this per-checkpoint section.
 */
export function buildRosterText(record: RoomRecord): string {
  return record.members
    .map((member) => {
      const displayName = member.displayName ?? member.id;
      const flags: string[] = [];
      if (member.joinedAt !== record.createdAt) flags.push("joined mid-discussion");
      if (member.status === "failed") flags.push("failed");
      const suffix = flags.length > 0 ? ` (${flags.join(", ")})` : "";
      return `- ${member.id} / ${displayName} / ${member.provider} / ${member.model ?? "default"} / persona: ${member.persona}${suffix}`;
    })
    .join("\n");
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
