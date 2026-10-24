import { describe, expect, test } from "vitest";
import type { RoomMember, RoomRecord } from "@getpaseo/protocol/room/types";
import { MAX_TURN_ATTEMPTS, stepRoomScheduler, type RoomEvent } from "./scheduler.js";

const AT = "2026-10-21T10:00:00.000Z";

function member(id: string): RoomMember {
  return {
    id,
    agentId: `agent-${id}`,
    provider: "claude",
    model: null,
    modeId: null,
    persona: `persona-${id}`,
    status: "ready",
    joinedAt: AT,
    lastDeliveredSeq: 0,
    turnCount: 0,
  };
}

function makeRecord(overrides: Partial<RoomRecord> = {}): RoomRecord {
  return {
    id: "room_1",
    workspaceId: "ws_1",
    name: "room",
    topic: "topic",
    status: "forming",
    promptVersion: 1,
    moderator: { agentId: "agent-mod", provider: "claude", model: null, modeId: null },
    members: [member("member_1"), member("member_2"), member("member_3")],
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
    transcript: [],
    interjections: [],
    lastSeq: 0,
    limits: { maxRounds: 6, maxTurns: 24, turnTimeoutMs: 900_000, deltaCharBudget: 24_000 },
    artifactPath: ".tasks/rooms/x/summary.md",
    summary: null,
    createdAt: AT,
    updatedAt: AT,
    closedAt: null,
    closedReason: null,
    ...overrides,
  };
}

function run(record: RoomRecord, events: RoomEvent[]) {
  let current = record;
  const results = events.map((event) => {
    const result = stepRoomScheduler(current, event);
    current = result.record;
    return result;
  });
  return { record: current, results };
}

const opening: RoomEvent = {
  type: "moderator_opening_ready",
  at: AT,
  opening: "开场",
  nextMemberId: "member_1",
};

function complete(memberId: string): RoomEvent {
  return {
    type: "member_turn_completed",
    at: AT,
    memberId,
    text: `speech-${memberId}`,
    turnId: `t-${memberId}`,
  };
}

describe("RoomScheduler rotation", () => {
  test("creates members and asks the moderator for the opening", () => {
    const { record, results } = run(makeRecord(), [{ type: "room_started", at: AT }]);

    expect(results[0]?.commands).toEqual([
      { type: "create_members" },
      { type: "ask_moderator", checkpoint: "opening" },
    ]);
    expect(record.status).toBe("opening");
  });

  test("follows turn order through a full round and then asks the moderator", () => {
    const { record, results } = run(makeRecord(), [
      { type: "room_started", at: AT },
      opening,
      complete("member_1"),
      complete("member_2"),
      complete("member_3"),
    ]);

    const prompts = results
      .flatMap((result) => result.commands)
      .filter((command) => command.type === "prompt_member")
      .map((command) => (command.type === "prompt_member" ? command.memberId : null));

    expect(prompts).toEqual(["member_1", "member_2", "member_3"]);
    expect(results.at(-1)?.commands).toEqual([{ type: "ask_moderator", checkpoint: "round_end" }]);
    expect(record.transcript.filter((entry) => entry.kind === "member")).toHaveLength(3);
    expect(record.turn.index).toBe(3);
  });

  test("reorders to a valid member and ignores an unknown member id", () => {
    const start = stepRoomScheduler(makeRecord(), { type: "room_started", at: AT }).record;
    const opened = stepRoomScheduler(start, opening).record;

    const unknown = stepRoomScheduler(opened, {
      type: "moderator_checkpoint_ready",
      at: AT,
      action: "reorder",
      nextMemberId: "member_missing",
    });
    expect(unknown.commands).toContainEqual(
      expect.objectContaining({ type: "prompt_member", memberId: "member_2" }),
    );
  });

  test("skips a member the moderator names at a checkpoint", () => {
    const start = stepRoomScheduler(makeRecord(), { type: "room_started", at: AT }).record;
    const opened = stepRoomScheduler(start, opening).record;

    const skipped = stepRoomScheduler(opened, {
      type: "moderator_checkpoint_ready",
      at: AT,
      action: "skip",
      nextMemberId: "member_2",
    });

    expect(skipped.record.round.remainingMemberIds).toEqual(["member_3"]);
    expect(skipped.commands).toEqual([{ type: "prompt_member", memberId: "member_3", attempt: 0 }]);
  });
});

describe("RoomScheduler timeout and retry", () => {
  test("cancels on timeout, retries once, then fails the member", () => {
    const { results } = run(makeRecord(), [
      { type: "room_started", at: AT },
      opening,
      { type: "turn_timeout", at: AT },
      { type: "turn_timeout", at: AT },
    ]);

    expect(results[2]?.commands).toEqual([
      { type: "cancel_agent", memberId: "member_1" },
      { type: "prompt_member", memberId: "member_1", attempt: 1 },
    ]);

    const afterSecondTimeout = results[3]!;
    expect(afterSecondTimeout.commands[0]).toEqual({
      type: "cancel_agent",
      memberId: "member_1",
    });
    expect(afterSecondTimeout.record.members[0]?.status).toBe("failed");
    expect(
      afterSecondTimeout.record.transcript.some(
        (entry) => entry.kind === "system" && entry.text.includes("failed"),
      ),
    ).toBe(true);
  });

  test("stops retrying after the attempt limit and moves on", () => {
    const { record, results } = run(makeRecord(), [
      { type: "room_started", at: AT },
      opening,
      { type: "member_turn_failed", at: AT, memberId: "member_1", reason: "boom" },
      { type: "member_turn_failed", at: AT, memberId: "member_1", reason: "boom" },
    ]);

    expect(results[2]?.commands).toEqual([
      { type: "prompt_member", memberId: "member_1", attempt: 1 },
    ]);
    // Second failure removes the member and prompts the next speaker.
    expect(results[3]?.commands).toEqual([
      { type: "prompt_member", memberId: "member_2", attempt: 0 },
    ]);
    expect(MAX_TURN_ATTEMPTS).toBe(2);
    expect(record.members[0]?.status).toBe("failed");
  });
});

describe("RoomScheduler pause and resume", () => {
  test("pause cancels the speaker and resume re-prompts it from a fresh turn", () => {
    const { record, results } = run(makeRecord(), [
      { type: "room_started", at: AT },
      opening,
      { type: "user_pause", at: AT },
      { type: "user_resume", at: "2026-10-21T10:05:00.000Z" },
    ]);

    expect(results[2]?.commands).toEqual([{ type: "cancel_agent", memberId: "member_1" }]);
    expect(record.status).toBe("discussing");
    expect(results[3]?.commands).toEqual([
      { type: "prompt_member", memberId: "member_1", attempt: 0 },
    ]);
    expect(record.turn).toMatchObject({
      memberId: "member_1",
      status: "speaking",
      attempt: 0,
      deadlineAt: "2026-10-21T10:20:00.000Z",
    });
  });

  test("a retry gets a fresh deadline window", () => {
    const { record } = run(makeRecord(), [
      { type: "room_started", at: AT },
      opening,
      {
        type: "member_turn_failed",
        at: "2026-10-21T10:10:00.000Z",
        memberId: "member_1",
        reason: "boom",
      },
    ]);

    expect(record.turn.deadlineAt).toBe("2026-10-21T10:25:00.000Z");
  });

  test("a late turn event does not advance a paused room", () => {
    const { record, results } = run(makeRecord(), [
      { type: "room_started", at: AT },
      opening,
      { type: "user_pause", at: AT },
      complete("member_1"),
    ]);

    expect(results[3]?.commands).toEqual([]);
    expect(record.status).toBe("interrupted");
    expect(record.turn.memberId).toBe("member_1");
  });

  test("pausing during a retry cancels the in-flight prompt", () => {
    const { results } = run(makeRecord(), [
      { type: "room_started", at: AT },
      opening,
      { type: "member_turn_failed", at: AT, memberId: "member_1", reason: "boom" },
      { type: "user_pause", at: AT },
    ]);

    expect(results[3]?.commands).toEqual([{ type: "cancel_agent", memberId: "member_1" }]);
  });

  test("an interjection during an interruption does not ask the moderator", () => {
    const { results } = run(makeRecord(), [
      { type: "room_started", at: AT },
      opening,
      { type: "user_pause", at: AT },
      { type: "interjection_queued", at: AT, interjectionId: "int_1", text: "等恢复再说" },
    ]);

    expect(results[3]?.commands).toEqual([]);
  });
});

describe("RoomScheduler interjections", () => {
  test("queues an interjection without interrupting the current speaker", () => {
    const { record, results } = run(makeRecord(), [
      { type: "room_started", at: AT },
      opening,
      { type: "interjection_queued", at: AT, interjectionId: "int_1", text: "等一下" },
    ]);

    expect(results[2]?.commands).toEqual([]);
    expect(record.turn.status).toBe("speaking");
    expect(record.interjections).toEqual([
      { id: "int_1", text: "等一下", createdAt: AT, status: "queued", decidedAt: null },
    ]);
    expect(record.transcript.at(-1)).toMatchObject({
      kind: "interjection",
      text: "等一下",
      interjectionId: "int_1",
    });
  });

  test("keeps interjections in arrival order while the room is speaking", () => {
    const { record } = run(makeRecord(), [
      { type: "room_started", at: AT },
      opening,
      { type: "interjection_queued", at: AT, interjectionId: "int_1", text: "第一句" },
      { type: "interjection_queued", at: AT, interjectionId: "int_2", text: "第二句" },
    ]);

    expect(record.interjections.map((interjection) => interjection.id)).toEqual(["int_1", "int_2"]);
    expect(
      record.transcript.filter((entry) => entry.kind === "interjection").map((entry) => entry.text),
    ).toEqual(["第一句", "第二句"]);
    // The current speaker was never cancelled or re-prompted.
    expect(record.turn).toMatchObject({ memberId: "member_1", status: "speaking", attempt: 0 });
  });

  test("an interjection in closing sends the room back to discussing", () => {
    const closing = makeRecord({ status: "closing", summary: "done" });
    const { record, results } = run(closing, [
      { type: "interjection_queued", at: AT, interjectionId: "int_1", text: "再聊聊" },
    ]);

    expect(results[0]?.commands).toEqual([{ type: "ask_moderator", checkpoint: "interjection" }]);
    expect(record.status).toBe("discussing");
    expect(record.pendingCheckpoint).toBe("interjection");
    expect(record.turn).toMatchObject({ memberId: null, status: "idle" });
  });

  test("asks the moderator immediately when no speaker is active", () => {
    const idle = makeRecord({ status: "discussing" });
    const { results } = run(idle, [
      { type: "interjection_queued", at: AT, interjectionId: "int_1", text: "hi" },
    ]);

    expect(results[0]?.commands).toEqual([{ type: "ask_moderator", checkpoint: "interjection" }]);
  });

  test("answers the user without consuming a member turn", () => {
    const { record } = run(makeRecord({ status: "discussing" }), [
      { type: "interjection_queued", at: AT, interjectionId: "int_1", text: "hi" },
      {
        type: "moderator_checkpoint_ready",
        at: AT,
        action: "answer_user",
        userReply: "收到",
      },
    ]);

    expect(record.transcript.at(-1)).toMatchObject({ kind: "moderator", text: "收到" });
    expect(record.interjections[0]?.status).toBe("answered");
    expect(record.turn.index).toBe(0);
  });
});

describe("RoomScheduler budget", () => {
  test("closes when maxTurns is reached", () => {
    const record = makeRecord({
      limits: { maxRounds: 6, maxTurns: 1, turnTimeoutMs: 900_000, deltaCharBudget: 24_000 },
    });

    const { record: final, results } = run(record, [
      { type: "room_started", at: AT },
      opening,
      complete("member_1"),
    ]);

    expect(results[2]?.commands).toEqual([{ type: "ask_moderator", checkpoint: "summary" }]);
    expect(final.status).toBe("closing");
    expect(
      final.transcript.some((entry) => entry.kind === "system" && entry.text.includes("maxTurns")),
    ).toBe(true);
  });

  test("closes when the moderator continues past maxRounds", () => {
    const record = makeRecord({
      limits: { maxRounds: 1, maxTurns: 24, turnTimeoutMs: 900_000, deltaCharBudget: 24_000 },
    });

    const { record: final } = run(record, [
      { type: "room_started", at: AT },
      opening,
      complete("member_1"),
      complete("member_2"),
      complete("member_3"),
      { type: "moderator_checkpoint_ready", at: AT, action: "continue" },
    ]);

    expect(final.status).toBe("closing");
    expect(
      final.transcript.some((entry) => entry.kind === "system" && entry.text.includes("maxRounds")),
    ).toBe(true);
  });

  test("only accepts finish at a round-end checkpoint", () => {
    const record = makeRecord({ status: "discussing" });
    const { record: final } = run(record, [
      { type: "moderator_checkpoint_ready", at: AT, action: "finish" },
    ]);

    // Downgraded to continue: a new turn starts instead of closing the room.
    expect(final.status).toBe("discussing");
  });

  test("closes when the moderator finishes at a round-end checkpoint", () => {
    const record = makeRecord({
      status: "discussing",
      pendingCheckpoint: "round_end",
      round: { index: 1, remainingMemberIds: [] },
    });
    const { record: final, results } = run(record, [
      { type: "moderator_checkpoint_ready", at: AT, action: "finish" },
    ]);

    expect(results[0]?.commands).toEqual([{ type: "ask_moderator", checkpoint: "summary" }]);
    expect(final.status).toBe("closing");
  });
});

describe("RoomScheduler mid-room joins", () => {
  const joiner = { ...member("member_4"), catchUpPending: true };

  function recordWithJoiner(base: RoomRecord): RoomRecord {
    return { ...base, members: [...base.members, joiner] };
  }

  test("member_added appends the join marker, queues the joiner and returns create_member", () => {
    const start = stepRoomScheduler(makeRecord(), { type: "room_started", at: AT }).record;
    const opened = stepRoomScheduler(start, opening).record;
    const result = stepRoomScheduler(recordWithJoiner(opened), {
      type: "member_added",
      at: AT,
      memberId: "member_4",
    });

    expect(result.commands).toEqual([{ type: "create_member", memberId: "member_4" }]);
    expect(result.record.round.remainingMemberIds).toContain("member_4");
    expect(result.record.transcript.at(-1)).toMatchObject({
      kind: "system",
      memberId: "member_4",
    });
    expect(result.record.transcript.at(-1)?.text).toContain("成员 member_4");
    expect(result.record.transcript.at(-1)?.text).toContain("将在本轮队尾发言");
  });

  test("member_added is ignored outside discussing and interrupted", () => {
    const result = stepRoomScheduler(recordWithJoiner(makeRecord()), {
      type: "member_added",
      at: AT,
      memberId: "member_4",
    });
    expect(result.commands).toEqual([]);
    expect(result.record.transcript).toHaveLength(0);
    expect(result.record.round.remainingMemberIds).toEqual([]);
  });

  test("member_added queues the joiner in an interrupted room", () => {
    const start = stepRoomScheduler(makeRecord(), { type: "room_started", at: AT }).record;
    const opened = stepRoomScheduler(start, opening).record;
    const paused = stepRoomScheduler(opened, { type: "user_pause", at: AT }).record;
    const result = stepRoomScheduler(recordWithJoiner(paused), {
      type: "member_added",
      at: AT,
      memberId: "member_4",
    });

    expect(result.record.status).toBe("interrupted");
    expect(result.record.round.remainingMemberIds).toContain("member_4");
    expect(result.commands).toEqual([{ type: "create_member", memberId: "member_4" }]);
  });

  test("completing the catch-up first turn clears catchUpPending", () => {
    const start = stepRoomScheduler(makeRecord(), { type: "room_started", at: AT }).record;
    const opened = stepRoomScheduler(start, opening).record;
    const joined = stepRoomScheduler(recordWithJoiner(opened), {
      type: "member_added",
      at: AT,
      memberId: "member_4",
    }).record;

    // member_1 is the current speaker; everyone else rotates through, and the
    // joiner's first (catch-up) turn completes last in the round.
    const { record } = run(joined, [
      complete("member_1"),
      complete("member_2"),
      complete("member_3"),
      complete("member_4"),
    ]);

    expect(record.members[3]?.catchUpPending).toBeFalsy();
    expect(record.members[3]?.turnCount).toBe(1);
  });
});

describe("RoomScheduler round markers", () => {
  test("writes a round marker at the first round and at every new round", () => {
    const { record } = run(makeRecord(), [
      { type: "room_started", at: AT },
      opening,
      complete("member_1"),
      complete("member_2"),
      complete("member_3"),
      { type: "moderator_checkpoint_ready", at: AT, action: "continue" },
    ]);

    const markers = record.transcript
      .filter((entry) => entry.kind === "system" && entry.text.startsWith("round:"))
      .map((entry) => entry.text);
    expect(markers).toEqual(["round:1", "round:2"]);
  });
});

describe("RoomScheduler summary gating", () => {
  test("applies a summary while the room is closing", () => {
    const { record } = run(makeRecord({ status: "closing" }), [
      { type: "moderator_summary_ready", at: AT, summary: "结论" },
    ]);

    expect(record.summary).toBe("结论");
    expect(record.status).toBe("closing");
    expect(record.transcript.at(-1)).toMatchObject({ kind: "moderator", text: "结论" });
  });

  test("drops a late summary once the room left closing", () => {
    const { record } = run(makeRecord({ status: "discussing" }), [
      { type: "moderator_summary_ready", at: AT, summary: "迟到的总结" },
    ]);

    expect(record.summary).toBeNull();
    expect(record.transcript).toHaveLength(0);
  });

  test("closing without a summary re-asks on user_close", () => {
    // A room left closing without a summary (daemon restart mid-summary) heals
    // by asking the moderator again instead of closing for good.
    const { record, results } = run(makeRecord({ status: "closing" }), [
      { type: "user_close", at: AT },
    ]);

    expect(results[0]?.commands).toEqual([{ type: "ask_moderator", checkpoint: "summary" }]);
    expect(record.status).toBe("closing");
    expect(record.pendingCheckpoint).toBe("summary");
  });
});
