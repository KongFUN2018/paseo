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
    // A checkpoint reply acts on the pending interjection checkpoint while no
    // speaker is active (replies that land mid-turn are stale and dropped).
    const pending = makeRecord({
      status: "discussing",
      pendingCheckpoint: "interjection",
      round: { index: 1, remainingMemberIds: ["member_2", "member_3"] },
    });

    const unknown = stepRoomScheduler(pending, {
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
    const pending = makeRecord({
      status: "discussing",
      pendingCheckpoint: "interjection",
      round: { index: 1, remainingMemberIds: ["member_2", "member_3"] },
    });

    const skipped = stepRoomScheduler(pending, {
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
        interjectionIds: ["int_1"],
      },
    ]);

    expect(record.transcript.at(-1)).toMatchObject({ kind: "moderator", text: "收到" });
    expect(record.interjections[0]?.status).toBe("answered");
    expect(record.interjections[0]?.decidedAt).toBe(AT);
    expect(record.turn.index).toBe(0);
  });

  test("answer_user settles exactly the interjections the prompt listed", () => {
    // Per-entry settlement (design §4.6.1): a reply may only settle the ids
    // its checkpoint prompt actually carried. An interjection queued while
    // the run was in flight stays queued for the next checkpoint.
    const { record } = run(makeRecord({ status: "discussing" }), [
      { type: "interjection_queued", at: AT, interjectionId: "int_1", text: "第一句" },
      { type: "interjection_queued", at: AT, interjectionId: "int_2", text: "第二句" },
      {
        type: "moderator_checkpoint_ready",
        at: AT,
        action: "answer_user",
        userReply: "收到",
        interjectionIds: ["int_1"],
      },
    ]);

    expect(record.interjections.find((entry) => entry.id === "int_1")?.status).toBe("answered");
    expect(record.interjections.find((entry) => entry.id === "int_2")?.status).toBe("queued");
    expect(record.interjections.find((entry) => entry.id === "int_2")?.decidedAt).toBeNull();
  });

  test("answer_user keeps the first decidedAt when an answered id is replayed", () => {
    const later = "2026-10-21T11:00:00.000Z";
    const { record } = run(makeRecord({ status: "discussing" }), [
      { type: "interjection_queued", at: AT, interjectionId: "int_1", text: "第一句" },
      {
        type: "moderator_checkpoint_ready",
        at: AT,
        action: "answer_user",
        userReply: "收到",
        interjectionIds: ["int_1"],
      },
      {
        type: "moderator_checkpoint_ready",
        at: later,
        action: "answer_user",
        userReply: "再回",
        interjectionIds: ["int_1"],
      },
    ]);

    expect(record.interjections[0]?.status).toBe("answered");
    expect(record.interjections[0]?.decidedAt).toBe(AT);
  });

  test("a mid-speech interjection settles delivered at the checkpoint that listed it", () => {
    // Design §4.6.1 (2026-10-25 R9 #1): delivered means "presented to a
    // moderator checkpoint once". The interjection queued while member_1
    // spoke stays queued through the whole round (turn completion no longer
    // settles anything), is listed by the round_end prompt, and settles to
    // delivered only when that checkpoint's reply is consumed.
    const { record, results } = run(makeRecord(), [
      { type: "room_started", at: AT },
      opening,
      { type: "interjection_queued", at: AT, interjectionId: "int_1", text: "等一下" },
      complete("member_1"),
      complete("member_2"),
      complete("member_3"),
      {
        type: "moderator_checkpoint_ready",
        at: AT,
        action: "continue",
        interjectionIds: ["int_1"],
      },
    ]);

    // No state change at turn completion: the reply path is still intact.
    expect(results[3]?.record.interjections[0]?.status).toBe("queued");
    // round_end dispatched with the interjection still queued (it must be
    // listed — prompt filtering is queued-only).
    expect(results[5]?.commands).toEqual([{ type: "ask_moderator", checkpoint: "round_end" }]);
    // The checkpoint reply settles the snapshot: seen once → delivered.
    expect(record.interjections[0]?.status).toBe("delivered");
    // decidedAt belongs to answered semantics and stays untouched.
    expect(record.interjections[0]?.decidedAt).toBeNull();
  });

  test("an interjection never settles before a checkpoint reply arrives", () => {
    // Turn boundaries are no settlement points at all (R9 #1): without a
    // consumed checkpoint reply the interjection stays queued regardless of
    // when it queued relative to the turns.
    const { record } = run(makeRecord(), [
      { type: "room_started", at: AT },
      opening,
      complete("member_1"),
      { type: "interjection_queued", at: AT, interjectionId: "int_late", text: "晚到" },
      complete("member_2"),
    ]);

    expect(record.interjections[0]?.status).toBe("queued");
  });

  test("a checkpoint reply settles answer_user directly, without a delivered detour", () => {
    // answer_user settles its snapshot to answered in the same checkpoint;
    // only snapshot ids still queued after that (none here) would go delivered.
    const { record } = run(makeRecord(), [
      { type: "room_started", at: AT },
      opening,
      { type: "interjection_queued", at: AT, interjectionId: "int_1", text: "等一下" },
      complete("member_1"),
      complete("member_2"),
      complete("member_3"),
      {
        type: "moderator_checkpoint_ready",
        at: AT,
        action: "answer_user",
        userReply: "收到",
        interjectionIds: ["int_1"],
      },
    ]);

    expect(record.interjections[0]?.status).toBe("answered");
    expect(record.interjections[0]?.decidedAt).toBe(AT);
  });

  test("a checkpoint reply leaves out-of-snapshot interjections queued", () => {
    // The run's snapshot predates the second interjection: it was not listed,
    // so it stays queued for the next checkpoint (design §4.6.1).
    const { record } = run(makeRecord({ status: "discussing" }), [
      { type: "interjection_queued", at: AT, interjectionId: "int_1", text: "第一句" },
      { type: "interjection_queued", at: AT, interjectionId: "int_2", text: "第二句" },
      {
        type: "moderator_checkpoint_ready",
        at: AT,
        action: "continue",
        interjectionIds: ["int_1"],
      },
    ]);

    expect(record.interjections.find((entry) => entry.id === "int_1")?.status).toBe("delivered");
    expect(record.interjections.find((entry) => entry.id === "int_2")?.status).toBe("queued");
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

    // No checkpoint was pending, so the reply is stale and dropped: the room
    // stays discussing instead of closing.
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

describe("RoomScheduler stale checkpoint replies", () => {
  // Regression (2026-10-25 acceptance §4): an interjection checkpoint fired
  // while a round_end run was still in flight makes the racing fallback feed a
  // second moderator_checkpoint_ready. The duplicate must never start another
  // member turn while one is already streaming, or the next prompt for the
  // still-running member fails on AgentManager's active-run guard and the
  // seat is lost permanently.
  // These cases are defense line ③ (design §7.7): the checkpointRunId match
  // at the service backfill boundary (line ①) and the per-room run
  // serialization (line ②) run first; this reducer guard stays as the
  // last-resort assertion for replies whose id is still current but whose
  // turn window has moved on.

  function roundTwoWithSpeaker(): RoomRecord {
    // Round 2 started: member_1 is speaking, member_2 waits in the round.
    return makeRecord({
      status: "discussing",
      round: { index: 2, remainingMemberIds: ["member_2"] },
      turn: {
        index: 3,
        memberId: "member_1",
        agentId: "agent-member_1",
        turnId: null,
        status: "speaking",
        startedAt: AT,
        deadlineAt: AT,
        attempt: 0,
      },
    });
  }

  test("drops a duplicate reply once its checkpoint was consumed", () => {
    const { record, results } = run(roundTwoWithSpeaker(), [
      { type: "moderator_checkpoint_ready", at: AT, action: "continue", nextMemberId: "member_2" },
    ]);

    expect(results[0]?.commands).toEqual([]);
    expect(record.turn).toMatchObject({ memberId: "member_1", status: "speaking" });
    expect(record.round.remainingMemberIds).toEqual(["member_2"]);
  });

  test("drops a reply that lands while a speaker is active even if a checkpoint is pending", () => {
    const { record, results } = run(
      makeRecord({
        ...roundTwoWithSpeaker(),
        pendingCheckpoint: "interjection",
      }),
      [{ type: "moderator_checkpoint_ready", at: AT, action: "continue" }],
    );

    expect(results[0]?.commands).toEqual([]);
    expect(record.turn.status).toBe("speaking");
    // The stale pending checkpoint stays for the reply that actually owns it.
    expect(record.pendingCheckpoint).toBe("interjection");
  });

  test("a reply while idle with a pending checkpoint still acts", () => {
    const { results } = run(
      makeRecord({
        status: "discussing",
        pendingCheckpoint: "interjection",
        round: { index: 1, remainingMemberIds: ["member_1", "member_2", "member_3"] },
      }),
      [{ type: "moderator_checkpoint_ready", at: AT, action: "continue" }],
    );

    expect(results[0]?.commands).toEqual([
      { type: "prompt_member", memberId: "member_1", attempt: 0 },
    ]);
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

  test("member_added marker omits the persona segment for an empty persona", () => {
    const start = stepRoomScheduler(makeRecord(), { type: "room_started", at: AT }).record;
    const opened = stepRoomScheduler(start, opening).record;
    const result = stepRoomScheduler(
      recordWithJoiner({ ...opened, members: [...opened.members, { ...joiner, persona: "" }] }),
      { type: "member_added", at: AT, memberId: "member_4" },
    );

    const marker = result.record.transcript.at(-1)?.text ?? "";
    expect(marker).toContain("成员 member_4（claude/default）加入房间");
    expect(marker).not.toContain("，）");
  });

  test("member_added marker keeps the persona digest for a non-empty persona", () => {
    const start = stepRoomScheduler(makeRecord(), { type: "room_started", at: AT }).record;
    const opened = stepRoomScheduler(start, opening).record;
    const result = stepRoomScheduler(
      recordWithJoiner({
        ...opened,
        members: [...opened.members, { ...joiner, persona: "负责回归测试" }],
      }),
      { type: "member_added", at: AT, memberId: "member_4" },
    );

    const marker = result.record.transcript.at(-1)?.text ?? "";
    expect(marker).toBe("成员 member_4（claude/default，负责回归测试）加入房间，将在本轮队尾发言");
  });

  test("member_added marker truncates a persona past 60 characters", () => {
    const longPersona = "长".repeat(80);
    const start = stepRoomScheduler(makeRecord(), { type: "room_started", at: AT }).record;
    const opened = stepRoomScheduler(start, opening).record;
    const result = stepRoomScheduler(
      recordWithJoiner({
        ...opened,
        members: [...opened.members, { ...joiner, persona: longPersona }],
      }),
      { type: "member_added", at: AT, memberId: "member_4" },
    );

    const marker = result.record.transcript.at(-1)?.text ?? "";
    expect(marker).toContain(`，${"长".repeat(60)}…）加入房间`);
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

  test("a second summary reply never lands a second entry", () => {
    // Double close or the closing re-ask heal can race a second summary run
    // whose reply lands after the first one wrote; only one entry may land
    // (design §7.2.1 residual #2).
    const { record } = run(makeRecord({ status: "closing" }), [
      { type: "moderator_summary_ready", at: AT, summary: "结论一" },
      { type: "moderator_summary_ready", at: AT, summary: "结论二" },
    ]);

    expect(record.summary).toBe("结论一");
    expect(record.transcript.filter((entry) => entry.kind === "moderator")).toHaveLength(1);
    expect(record.transcript.at(-1)).toMatchObject({ kind: "moderator", text: "结论一" });
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
