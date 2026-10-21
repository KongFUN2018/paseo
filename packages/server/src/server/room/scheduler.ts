import type {
  RoomCheckpoint,
  RoomMember,
  RoomRecord,
  RoomTranscriptEntry,
} from "@getpaseo/protocol/room/types";

/**
 * Deterministic room scheduler.
 *
 * Pure reducer: it reads no clock, touches no disk, and imports nothing from AgentManager.
 * The caller passes the current time in each event and executes the returned commands.
 */
export type RoomEvent =
  | { type: "room_started"; at: string }
  | { type: "moderator_opening_ready"; at: string; opening: string; nextMemberId?: string | null }
  | {
      type: "member_turn_completed";
      at: string;
      memberId: string;
      text: string;
      turnId?: string | null;
    }
  | { type: "member_turn_failed"; at: string; memberId: string; reason: string }
  | { type: "interjection_queued"; at: string; interjectionId: string; text: string }
  | {
      type: "moderator_checkpoint_ready";
      at: string;
      action: ModeratorAction;
      nextMemberId?: string | null;
      reason?: string;
      userReply?: string | null;
    }
  | { type: "turn_timeout"; at: string }
  | { type: "user_pause"; at: string }
  | { type: "user_resume"; at: string }
  | { type: "user_close"; at: string }
  | { type: "budget_exhausted"; at: string; reason: string };

export type ModeratorAction = "continue" | "reorder" | "skip" | "finish" | "answer_user";

export type RoomCommand =
  | { type: "create_members" }
  | { type: "ask_moderator"; checkpoint: RoomCheckpoint }
  | { type: "prompt_member"; memberId: string; attempt: number }
  | { type: "cancel_agent"; memberId: string };

export interface SchedulerStepResult {
  record: RoomRecord;
  commands: RoomCommand[];
}

/** Maximum attempts per speaker: one first try plus one retry. */
export const MAX_TURN_ATTEMPTS = 2;

function cloneRecord(record: RoomRecord): RoomRecord {
  return structuredClone(record);
}

function appendEntry(
  record: RoomRecord,
  entry: Omit<RoomTranscriptEntry, "seq">,
): RoomTranscriptEntry {
  const seq = record.lastSeq + 1;
  const full = { ...entry, seq } as RoomTranscriptEntry;
  record.transcript.push(full);
  record.lastSeq = seq;
  return full;
}

function findMember(record: RoomRecord, memberId: string | null): RoomMember | undefined {
  if (!memberId) return undefined;
  return record.members.find((member) => member.id === memberId);
}

function activeMemberIds(record: RoomRecord): string[] {
  return record.members.filter((member) => member.status !== "archived").map((member) => member.id);
}

function turnOrder(record: RoomRecord): string[] {
  return activeMemberIds(record);
}

function isValidMemberId(
  record: RoomRecord,
  memberId: string | null | undefined,
): memberId is string {
  return typeof memberId === "string" && record.members.some((member) => member.id === memberId);
}

function isBudgetExhausted(record: RoomRecord): string | null {
  if (record.turn.index >= record.limits.maxTurns) {
    return `maxTurns (${record.limits.maxTurns}) reached`;
  }
  if (record.round.index > record.limits.maxRounds) {
    return `maxRounds (${record.limits.maxRounds}) reached`;
  }
  return null;
}

function beginClosing(record: RoomRecord, at: string, reason: string | null): RoomCommand[] {
  record.status = "closing";
  record.updatedAt = at;
  if (reason) {
    appendEntry(record, {
      at,
      kind: "system",
      memberId: null,
      agentId: null,
      text: reason,
      turnId: null,
    });
  }
  record.pendingCheckpoint = "summary";
  return [{ type: "ask_moderator", checkpoint: "summary" }];
}

/** Marks the current speaker as prompted and returns the prompt command. */
function startTurn(record: RoomRecord, memberId: string, at: string): RoomCommand[] {
  const member = findMember(record, memberId);
  if (!member) return [];
  const attempt = record.turn.memberId === memberId ? record.turn.attempt + 1 : 0;
  record.turn = {
    index: record.turn.index,
    memberId,
    agentId: member.agentId,
    turnId: null,
    status: "speaking",
    startedAt: at,
    deadlineAt: new Date(new Date(at).getTime() + record.limits.turnTimeoutMs).toISOString(),
    attempt,
  };
  member.status = "speaking";
  record.updatedAt = at;
  return [{ type: "prompt_member", memberId, attempt }];
}

function startNextTurn(
  record: RoomRecord,
  at: string,
  preferredMemberId: string | null,
): RoomCommand[] {
  const budgetReason = isBudgetExhausted(record);
  if (budgetReason) {
    return beginClosing(record, at, `Budget exhausted: ${budgetReason}`);
  }
  const memberId =
    isValidMemberId(record, preferredMemberId) &&
    record.round.remainingMemberIds.includes(preferredMemberId)
      ? preferredMemberId
      : (record.round.remainingMemberIds[0] ?? null);
  if (!memberId) {
    record.pendingCheckpoint = "round_end";
    return [{ type: "ask_moderator", checkpoint: "round_end" }];
  }
  return startTurn(record, memberId, at);
}

function completeTurn(record: RoomRecord, memberId: string, at: string): void {
  record.round.remainingMemberIds = record.round.remainingMemberIds.filter((id) => id !== memberId);
  record.turn = {
    index: record.turn.index + 1,
    memberId: null,
    agentId: null,
    turnId: null,
    status: "idle",
    startedAt: null,
    deadlineAt: null,
    attempt: 0,
  };
  record.updatedAt = at;
}

function handleFailure(
  record: RoomRecord,
  at: string,
  memberId: string,
  reason: string,
): RoomCommand[] {
  const member = findMember(record, memberId);
  if (!member) return [];
  const attempt = record.turn.attempt + 1;
  if (attempt < MAX_TURN_ATTEMPTS) {
    // Retry the same member once, with a fresh timeout window for the retry.
    record.turn.attempt = attempt;
    record.turn.status = "retrying";
    record.turn.startedAt = at;
    record.turn.deadlineAt = new Date(
      new Date(at).getTime() + record.limits.turnTimeoutMs,
    ).toISOString();
    record.updatedAt = at;
    member.status = "speaking";
    return [{ type: "prompt_member", memberId, attempt }];
  }

  appendEntry(record, {
    at,
    kind: "system",
    memberId,
    agentId: member.agentId,
    text: `Member ${memberId} failed: ${reason}`,
    turnId: null,
  });
  member.status = "failed";
  record.round.remainingMemberIds = record.round.remainingMemberIds.filter((id) => id !== memberId);
  record.turn = {
    index: record.turn.index + 1,
    memberId: null,
    agentId: null,
    turnId: null,
    status: "idle",
    startedAt: null,
    deadlineAt: null,
    attempt: 0,
  };
  record.updatedAt = at;

  if (activeMemberIds(record).length === 0) {
    return beginClosing(record, at, "No usable members remain");
  }
  if (record.round.remainingMemberIds.length === 0) {
    record.pendingCheckpoint = "round_end";
    return [{ type: "ask_moderator", checkpoint: "round_end" }];
  }
  return startNextTurn(record, at, null);
}

function pendingInterjections(record: RoomRecord) {
  return record.interjections.filter((interjection) => interjection.status === "queued");
}

function handleOpeningReady(
  record: RoomRecord,
  event: Extract<RoomEvent, { type: "moderator_opening_ready" }>,
): RoomCommand[] {
  appendEntry(record, {
    at: event.at,
    kind: "opening",
    memberId: null,
    agentId: record.moderator.agentId,
    text: event.opening,
    turnId: null,
  });
  record.status = "discussing";
  record.round = { index: 1, remainingMemberIds: turnOrder(record) };
  record.pendingCheckpoint = null;
  const first = isValidMemberId(record, event.nextMemberId)
    ? event.nextMemberId
    : (record.round.remainingMemberIds[0] ?? null);
  if (!first) {
    return beginClosing(record, event.at, "Room has no members");
  }
  record.round.remainingMemberIds = record.round.remainingMemberIds.filter((id) => id !== first);
  return startTurn(record, first, event.at);
}

function handleTurnCompleted(
  record: RoomRecord,
  event: Extract<RoomEvent, { type: "member_turn_completed" }>,
): RoomCommand[] {
  const member = findMember(record, event.memberId);
  if (!member) return [];
  appendEntry(record, {
    at: event.at,
    kind: "member",
    memberId: member.id,
    agentId: member.agentId,
    text: event.text,
    turnId: event.turnId ?? null,
  });
  member.lastDeliveredSeq = record.lastSeq;
  member.turnCount += 1;
  member.status = "ready";
  completeTurn(record, member.id, event.at);
  if (record.round.remainingMemberIds.length === 0) {
    record.pendingCheckpoint = "round_end";
    return [{ type: "ask_moderator", checkpoint: "round_end" }];
  }
  return startNextTurn(record, event.at, null);
}

function handleInterjectionQueued(
  record: RoomRecord,
  event: Extract<RoomEvent, { type: "interjection_queued" }>,
): RoomCommand[] {
  appendEntry(record, {
    at: event.at,
    kind: "interjection",
    memberId: null,
    agentId: null,
    text: event.text,
    interjectionId: event.interjectionId,
  });
  record.interjections.push({
    id: event.interjectionId,
    text: event.text,
    createdAt: event.at,
    status: "queued",
    decidedAt: null,
  });
  record.updatedAt = event.at;
  // Never interrupt the current speaker; the moderator decides at the next checkpoint.
  // Interjections queue only while the room is interrupted; that is not a checkpoint.
  if (record.status === "discussing" && record.turn.status === "idle") {
    record.pendingCheckpoint = "interjection";
    return [{ type: "ask_moderator", checkpoint: "interjection" }];
  }
  return [];
}

function handleResume(
  record: RoomRecord,
  event: Extract<RoomEvent, { type: "user_resume" }>,
): RoomCommand[] {
  if (record.status !== "interrupted") return [];
  record.status = "discussing";
  record.updatedAt = event.at;
  const interruptedMemberId = record.turn.status === "idle" ? null : record.turn.memberId;
  // A resumed turn is a fresh turn: reset the attempt counter, then re-prompt the
  // interrupted speaker. It never left the round queue, so it is not in
  // remainingMemberIds anymore.
  record.turn = {
    index: record.turn.index,
    memberId: null,
    agentId: null,
    turnId: null,
    status: "idle",
    startedAt: null,
    deadlineAt: null,
    attempt: 0,
  };
  if (!interruptedMemberId) {
    return startNextTurn(record, event.at, null);
  }
  const member = findMember(record, interruptedMemberId);
  if (member) member.status = "ready";
  return startTurn(record, interruptedMemberId, event.at);
}

function handleCheckpoint(
  record: RoomRecord,
  event: Extract<RoomEvent, { type: "moderator_checkpoint_ready" }>,
): RoomCommand[] {
  const commands: RoomCommand[] = [];
  const checkpoint = record.pendingCheckpoint;
  record.pendingCheckpoint = null;

  if (event.action === "answer_user" && event.userReply) {
    appendEntry(record, {
      at: event.at,
      kind: "moderator",
      memberId: null,
      agentId: record.moderator.agentId,
      text: event.userReply,
      turnId: null,
    });
    for (const interjection of pendingInterjections(record)) {
      interjection.status = "answered";
      interjection.decidedAt = event.at;
    }
    record.updatedAt = event.at;
  }

  if (checkpoint === "summary") {
    record.status = "closing";
    record.updatedAt = event.at;
    return commands;
  }

  if (checkpoint === "round_end") {
    if (event.action === "finish") {
      return beginClosing(record, event.at, null);
    }
    const nextRound = { index: record.round.index + 1, remainingMemberIds: turnOrder(record) };
    const budgetReason = isBudgetExhausted({ ...record, round: nextRound });
    if (budgetReason) {
      return beginClosing(record, event.at, `Budget exhausted: ${budgetReason}`);
    }
    record.round = nextRound;
    return startNextTurn(record, event.at, event.nextMemberId ?? null);
  }

  // Opening/interjection checkpoints: finish is not accepted outside a round end.
  const action: ModeratorAction = event.action === "finish" ? "continue" : event.action;
  if (action === "skip" && isValidMemberId(record, event.nextMemberId)) {
    record.round.remainingMemberIds = record.round.remainingMemberIds.filter(
      (id) => id !== event.nextMemberId,
    );
  }
  const preferred =
    action === "reorder" && isValidMemberId(record, event.nextMemberId) ? event.nextMemberId : null;
  return startNextTurn(record, event.at, preferred);
}

export function stepRoomScheduler(record: RoomRecord, event: RoomEvent): SchedulerStepResult {
  const next = cloneRecord(record);
  const commands: RoomCommand[] = [];

  switch (event.type) {
    case "room_started": {
      next.status = "opening";
      next.updatedAt = event.at;
      commands.push({ type: "create_members" });
      next.pendingCheckpoint = "opening";
      commands.push({ type: "ask_moderator", checkpoint: "opening" });
      break;
    }

    case "moderator_opening_ready": {
      commands.push(...handleOpeningReady(next, event));
      break;
    }

    case "member_turn_completed": {
      commands.push(...handleTurnCompleted(next, event));
      break;
    }

    case "member_turn_failed": {
      commands.push(...handleFailure(next, event.at, event.memberId, event.reason));
      break;
    }

    case "turn_timeout": {
      const memberId = next.turn.memberId;
      if (!memberId) break;
      commands.push({ type: "cancel_agent", memberId });
      commands.push(...handleFailure(next, event.at, memberId, "turn timed out"));
      break;
    }

    case "interjection_queued": {
      commands.push(...handleInterjectionQueued(next, event));
      break;
    }

    case "moderator_checkpoint_ready": {
      commands.push(...handleCheckpoint(next, event));
      break;
    }

    case "user_pause": {
      next.status = "interrupted";
      next.updatedAt = event.at;
      if (next.turn.status === "speaking" && next.turn.memberId) {
        commands.push({ type: "cancel_agent", memberId: next.turn.memberId });
      }
      break;
    }

    case "user_resume": {
      commands.push(...handleResume(next, event));
      break;
    }

    case "user_close": {
      if (next.turn.status === "speaking" && next.turn.memberId) {
        commands.push({ type: "cancel_agent", memberId: next.turn.memberId });
      }
      commands.push(...beginClosing(next, event.at, null));
      break;
    }

    case "budget_exhausted": {
      commands.push(...beginClosing(next, event.at, `Budget exhausted: ${event.reason}`));
      break;
    }
  }

  return { record: next, commands };
}
