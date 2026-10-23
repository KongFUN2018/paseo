import { describe, expect, test } from "vitest";
import type { RoomMember, RoomRecord } from "@getpaseo/protocol/room/types";
import { collectDelta } from "./prompt.js";

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
