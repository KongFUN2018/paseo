import { describe, expect, test } from "vitest";
import type { RoomMember, RoomRecord } from "@getpaseo/protocol/room/types";
import {
  buildCatchupSummaryPrompt,
  buildCatchupTurnPrompt,
  buildCheckpointPrompt,
  buildHumanizedTranscript,
  buildMemberSystemPrompt,
  buildMemberTurnPrompt,
  buildModeratorSystemPrompt,
  buildRosterText,
  buildSummaryPrompt,
  collectDelta,
} from "./prompt.js";
import { ROLE_PROMPTS } from "./role-prompts.js";

const AT = "2026-10-21T10:00:00.000Z";

function member(id: string, lastDeliveredSeq = 0): RoomMember {
  return {
    id,
    agentId: `agent-${id}`,
    provider: "claude",
    model: null,
    modeId: null,
    persona: `persona-${id}`,
    status: "ready",
    joinedAt: AT,
    lastDeliveredSeq,
    turnCount: 0,
  };
}

function recordWith(
  texts: Array<{
    seq: number;
    kind: RoomRecord["transcript"][number]["kind"];
    memberId: string | null;
    text: string;
  }>,
  deltaCharBudget: number,
): RoomRecord {
  return {
    id: "room_1",
    workspaceId: "ws_1",
    name: "room",
    topic: "topic",
    status: "discussing",
    promptVersion: 1,
    moderator: { agentId: "agent-mod", provider: "claude", model: null, modeId: null },
    members: [member("member_1"), member("member_2")],
    turn: {
      index: 0,
      memberId: null,
      agentId: null,
      turnId: null,
      status: "idle",
      startedAt: null,
      deadlineAt: null,
      attempt: 0,
    },
    round: { index: 1, remainingMemberIds: [] },
    transcript: texts.map((entry) => ({
      seq: entry.seq,
      at: AT,
      kind: entry.kind,
      memberId: entry.memberId,
      agentId: null,
      text: entry.text,
      turnId: null,
    })),
    interjections: [],
    lastSeq: texts.at(-1)?.seq ?? 0,
    limits: { maxRounds: 6, maxTurns: 24, turnTimeoutMs: 900_000, deltaCharBudget },
    artifactPath: "notes/summary.md",
    summary: null,
    createdAt: AT,
    updatedAt: AT,
    closedAt: null,
    closedReason: null,
  };
}

describe("buildMemberSystemPrompt", () => {
  test("v2 embeds the room rules, the role template and the output directory", () => {
    const named: RoomMember = { ...member("member_1"), displayName: "可靠性", roleId: "backend" };
    const prompt = buildMemberSystemPrompt({
      promptVersion: 2,
      roomName: "架构评审",
      member: named,
      filesDir: ".paseo/rooms/x",
    });
    expect(prompt).toContain("你是多模型聊天室「架构评审」的成员，名字：可靠性。");
    expect(prompt).toContain("你的职责视角：后端");
    expect(prompt).toContain("你的产出物目录：.paseo/rooms/x/member_1/");
    expect(prompt).toContain("## 聊天室交流守则");
    expect(prompt).toContain("1. 一行一句完整的话。");
    expect(prompt).toContain("8. 直接说观点，不复述其他成员的发言原文。");
  });

  test("falls back to the generic template when no roleId matches", () => {
    const prompt = buildMemberSystemPrompt({
      promptVersion: 2,
      roomName: "评审",
      member: member("member_1"),
      filesDir: ".paseo/rooms/x",
    });
    expect(prompt).toContain(
      "你的职责视角：persona-member_1。从你的职责出发给判断，不是来写代码或写报告的。",
    );
  });

  test("keeps the v1 template for legacy rooms", () => {
    const prompt = buildMemberSystemPrompt({
      promptVersion: 1,
      roomName: "评审",
      member: member("member_1"),
      filesDir: ".paseo/rooms/x",
    });
    expect(prompt).toContain("You are member member_1 of the chat room 评审.");
    expect(prompt).not.toContain("聊天室交流守则");
  });
});

describe("buildMemberTurnPrompt", () => {
  test("v2 ends with the rules recap line and injects new files when present", () => {
    const record: RoomRecord = { ...recordWith([], 24_000), promptVersion: 2 };
    const prompt = buildMemberTurnPrompt({
      record,
      member: member("member_1"),
      moderatorNote: null,
      retryReason: null,
      newFiles: null,
    });
    expect(prompt).toContain("[第 1 轮｜第 0 个 turn]");
    expect(prompt).toContain("主持人指示：继续原顺序");
    expect(prompt).not.toContain("新增产出物");
    expect(
      prompt.endsWith(
        "请发言。遵守守则：结论先行；≤5 句；上一条发言或点名与你相关时先回应；长内容给路径。",
      ),
    ).toBe(true);

    const withFiles = buildMemberTurnPrompt({
      record,
      member: member("member_1"),
      moderatorNote: null,
      retryReason: null,
      newFiles: "- notes/a.md（member_1，10 bytes）",
    });
    expect(withFiles).toContain("新增产出物：\n- notes/a.md（member_1，10 bytes）");

    const retry = buildMemberTurnPrompt({
      record,
      member: member("member_1"),
      moderatorNote: null,
      retryReason: "previous attempt failed",
      newFiles: null,
    });
    expect(retry).toContain("Your previous attempt failed (previous attempt failed); try again.");
  });

  test("keeps the v1 turn template with its stable tail line", () => {
    const prompt = buildMemberTurnPrompt({
      record: recordWith([], 24_000),
      member: member("member_1"),
      moderatorNote: null,
      retryReason: null,
      newFiles: null,
    });
    expect(prompt).toContain("[round 1 | turn 0]");
    expect(prompt.endsWith("Give your statement for this round.")).toBe(true);
  });
});

describe("catch-up prompts", () => {
  test("the catch-up turn prompt carries topic, transcript and file manifest", () => {
    const prompt = buildCatchupTurnPrompt({
      roomName: "架构评审",
      topic: "选题",
      transcriptText: "- 主持人: 开场白",
      fileManifest: "- notes/a.md（member_1，10 bytes）",
    });
    expect(prompt).toContain("[catch-up｜你刚加入聊天室「架构评审」]");
    expect(prompt).toContain("用户任务：\n选题");
    expect(prompt).toContain("- 主持人: 开场白");
    expect(prompt).toContain("- notes/a.md（member_1，10 bytes）");
    expect(prompt).toContain("请先用一句话向大家好");
  });

  test("the digest prompt asks for at most 400 Chinese characters", () => {
    const prompt = buildCatchupSummaryPrompt("- member_1: 观点");
    expect(prompt).toContain("at most 400 Chinese characters");
    expect(prompt).toContain("- member_1: 观点");
    expect(prompt).toContain("Reply with the digest body only.");
  });

  test("humanizes the transcript with display names and interjection marks", () => {
    const record = recordWith(
      [
        { seq: 1, kind: "opening", memberId: null, text: "开场" },
        { seq: 2, kind: "member", memberId: "member_2", text: "观点" },
        { seq: 3, kind: "interjection", memberId: null, text: "插话" },
      ],
      24_000,
    );
    const text = buildHumanizedTranscript({
      ...record,
      members: [member("member_1"), { ...member("member_2"), displayName: "成本" }],
    });
    expect(text).toContain("- 主持人: 开场");
    expect(text).toContain("- 成本: 观点");
    expect(text).toContain("- 用户插话: 插话");
  });
});

describe("moderator prompts", () => {
  test("the checkpoint prompt carries the roster section", () => {
    const record = recordWith([{ seq: 1, kind: "opening", memberId: null, text: "开场" }], 24_000);
    const prompt = buildCheckpointPrompt({
      round: 1,
      turnCount: 1,
      roster: buildRosterText(record),
      recentTranscript: "- x",
      pendingInterjections: "（none）",
    });
    expect(prompt).toContain("Current roster:");
    expect(prompt).toContain(
      "- member_1 / member_1 / claude / default / persona: persona-member_1",
    );
  });

  test("the roster flags members that joined mid-discussion or failed", () => {
    const record = recordWith([], 24_000);
    const late: RoomMember = {
      ...member("member_2"),
      joinedAt: "2026-10-21T11:00:00.000Z",
      status: "failed",
    };
    const text = buildRosterText({ ...record, members: [member("member_1"), late] });
    expect(text).toContain(
      "- member_2 / member_2 / claude / default / persona: persona-member_2 (joined mid-discussion, failed)",
    );
    expect(text).not.toContain(
      "member_1 / member_1 / claude / default / persona: persona-member_1 (",
    );
  });

  test("the moderator system prompt covers mid-discussion joins and member rules", () => {
    const prompt = buildModeratorSystemPrompt({
      workspaceDirectory: "/ws",
      roomName: "评审",
      members: [],
    });
    expect(prompt).toContain(
      "Members may join mid-discussion; the checkpoint prompt always carries the authoritative roster.",
    );
    expect(prompt).toContain(
      "Member statements follow room rules: one complete sentence per line, at most 5 sentences, conclusion first.",
    );
  });

  test("the closing summary is capped at 400 Chinese characters", () => {
    expect(buildSummaryPrompt()).toContain("- At most 400 Chinese characters, conclusion first.");
    expect(buildSummaryPrompt()).not.toContain("800 words");
  });
});

describe("role prompts", () => {
  test("ships the nine default roles", () => {
    expect(Object.keys(ROLE_PROMPTS).sort()).toEqual([
      "architect",
      "backend",
      "data",
      "dba",
      "frontend",
      "ops",
      "product",
      "qa",
      "security",
    ]);
  });
});

describe("collectDelta", () => {
  test("returns only entries the member has not seen, excluding its own", () => {
    const record = recordWith(
      [
        { seq: 1, kind: "opening", memberId: null, text: "开场" },
        { seq: 2, kind: "member", memberId: "member_1", text: "自己的旧发言" },
        { seq: 3, kind: "member", memberId: "member_2", text: "对方旧发言" },
        { seq: 4, kind: "member", memberId: "member_2", text: "对方新发言" },
      ],
      24_000,
    );

    const delta = collectDelta(record, member("member_1", 3), record.limits);
    expect(delta).toBe("- member_2: 对方新发言");
  });

  test("marks an empty delta when the member has seen everything", () => {
    const record = recordWith(
      [{ seq: 1, kind: "member", memberId: "member_2", text: "发言" }],
      24_000,
    );

    const delta = collectDelta(record, member("member_1", 1), record.limits);
    expect(delta).toBe("（你还没有发过言）");
  });

  test("truncates to the char budget keeping the newest tail", () => {
    const record = recordWith(
      [
        { seq: 1, kind: "member", memberId: "member_2", text: "旧".repeat(600) },
        { seq: 2, kind: "member", memberId: "member_2", text: "新".repeat(500) },
      ],
      700,
    );

    const delta = collectDelta(record, member("member_1", 0), record.limits);
    // Marker line plus the newest 700 chars of the joined lines.
    expect(delta.startsWith("（更早内容已截断）\n")).toBe(true);
    const tail = delta.slice("（更早内容已截断）\n".length);
    expect(tail.length).toBe(700);
    expect(tail.endsWith("新".repeat(500))).toBe(true);
  });
});
