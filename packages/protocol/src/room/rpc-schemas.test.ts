import { describe, expect, test } from "vitest";
import { SessionInboundMessageSchema, SessionOutboundMessageSchema } from "../messages.js";
import { ROOM_ID_LABEL, getRoomIdFromLabels } from "../agent-labels.js";

const baseRecord = {
  id: "room_ab12cd34",
  workspaceId: "ws_1",
  name: "架构评审",
  topic: "为结算服务选一个消息队列方案",
  status: "discussing",
  promptVersion: 1,
  moderator: { agentId: "agent-mod", provider: "claude", model: null, modeId: null },
  members: [
    {
      id: "member_1",
      agentId: "agent-1",
      provider: "claude",
      model: null,
      modeId: null,
      persona: "从可靠性角度评审",
      status: "ready",
      joinedAt: "2026-10-21T00:00:00.000Z",
      lastDeliveredSeq: 0,
      turnCount: 0,
    },
  ],
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
  round: { index: 1, remainingMemberIds: ["member_1"] },
  transcript: [
    {
      seq: 1,
      at: "2026-10-21T00:00:00.000Z",
      kind: "opening",
      memberId: null,
      agentId: "agent-mod",
      text: "开场",
      turnId: null,
    },
  ],
  interjections: [],
  lastSeq: 1,
  limits: { maxRounds: 6, maxTurns: 24, turnTimeoutMs: 900_000, deltaCharBudget: 24_000 },
  artifactPath: ".paseo/rooms/architecture-review/summary.md",
  summary: null,
  createdAt: "2026-10-21T00:00:00.000Z",
  updatedAt: "2026-10-21T00:00:00.000Z",
  closedAt: null,
  closedReason: null,
};

describe("room protocol", () => {
  test("parses every room request", () => {
    const requests = [
      {
        type: "room.create.request",
        requestId: "r1",
        workspaceId: "ws_1",
        name: "评审",
        topic: "选题",
        moderator: { provider: "claude", model: "claude-opus-5-5", modeId: null },
        members: [
          { provider: "codex", model: "gpt-5.1", persona: "运维视角" },
          { provider: "claude", model: "claude-opus-5-5", persona: "可靠性视角" },
        ],
        artifactPath: ".paseo/rooms/x/summary.md",
        limits: { maxRounds: 6 },
      },
      { type: "room.list.request", requestId: "r2" },
      { type: "room.get.request", requestId: "r3", roomId: "room_1" },
      { type: "room.start.request", requestId: "r4", roomId: "room_1", resume: true },
      { type: "room.pause.request", requestId: "r5", roomId: "room_1" },
      { type: "room.resume.request", requestId: "r6", roomId: "room_1" },
      { type: "room.interject.request", requestId: "r7", roomId: "room_1", text: "等一下" },
      { type: "room.close.request", requestId: "r8", roomId: "room_1" },
      { type: "room.reopen.request", requestId: "r9", roomId: "room_1" },
    ];

    for (const request of requests) {
      expect(SessionInboundMessageSchema.parse(request)).toEqual(request);
    }
  });

  test("parses room responses and the room_update push", () => {
    const responses = [
      {
        type: "room.create.response",
        payload: { requestId: "r1", roomId: "room_1", error: null },
      },
      {
        type: "room.list.response",
        payload: { requestId: "r2", rooms: [], error: null },
      },
      {
        type: "room.get.response",
        payload: { requestId: "r3", room: baseRecord, truncated: false, error: null },
      },
      {
        type: "room.start.response",
        payload: { requestId: "r4", room: baseRecord, error: null },
      },
      { type: "room_update", payload: { room: baseRecord } },
    ];

    for (const response of responses) {
      expect(SessionOutboundMessageSchema.parse(response)).toEqual(response);
    }
  });

  test("keeps new fields optional so older peers still parse", () => {
    const legacyRecord = { ...baseRecord };
    delete (legacyRecord as Record<string, unknown>).pendingCheckpoint;

    expect(
      SessionOutboundMessageSchema.parse({ type: "room_update", payload: { room: legacyRecord } }),
    ).toMatchObject({ payload: { room: { id: "room_ab12cd34" } } });

    // Interjection entries omit the optional turnId; the field stays optional.
    const withInterjection = {
      ...baseRecord,
      transcript: [
        ...baseRecord.transcript,
        {
          seq: 2,
          at: "2026-10-21T00:00:01.000Z",
          kind: "interjection",
          memberId: null,
          agentId: null,
          text: "插话",
          interjectionId: "int_1",
        },
      ],
    };
    expect(
      SessionOutboundMessageSchema.parse({
        type: "room_update",
        payload: { room: withInterjection },
      }),
    ).toMatchObject({ payload: { room: { lastSeq: 1 } } });
  });

  test("advertises the room feature as an optional boolean", () => {
    expect(
      SessionOutboundMessageSchema.parse({
        type: "status",
        payload: {
          status: "server_info",
          serverId: "srv_1",
          features: { room: true },
        },
      }),
    ).toMatchObject({ payload: { features: { room: true } } });
  });
});

describe("room member count", () => {
  const createRequest = (members: unknown[]) => ({
    type: "room.create.request",
    requestId: "r-count",
    workspaceId: "ws_1",
    name: "评审",
    topic: "选题",
    moderator: { provider: "claude" },
    members,
    artifactPath: ".paseo/rooms/x/summary.md",
  });
  const member = { provider: "codex", persona: "p" };

  test("rejects a room with a single member", () => {
    expect(() => SessionInboundMessageSchema.parse(createRequest([member]))).toThrow();
  });

  test("rejects a room with five members", () => {
    expect(() =>
      SessionInboundMessageSchema.parse(createRequest([member, member, member, member, member])),
    ).toThrow();
  });

  test("accepts a room with two members", () => {
    const request = createRequest([member, member]);
    expect(SessionInboundMessageSchema.parse(request)).toEqual(request);
  });

  test("accepts a room with four members", () => {
    const request = createRequest([member, member, member, member]);
    expect(SessionInboundMessageSchema.parse(request)).toEqual(request);
  });
});

describe("room label", () => {
  test("uses the documented label key", () => {
    expect(ROOM_ID_LABEL).toBe("paseo.room-id");
  });

  test("reads a trimmed room id and ignores empty or non-string values", () => {
    expect(getRoomIdFromLabels({ [ROOM_ID_LABEL]: " room_1 " })).toBe("room_1");
    expect(getRoomIdFromLabels({ [ROOM_ID_LABEL]: "   " })).toBeNull();
    expect(getRoomIdFromLabels({ [ROOM_ID_LABEL]: 42 })).toBeNull();
    expect(getRoomIdFromLabels({})).toBeNull();
    expect(getRoomIdFromLabels(null)).toBeNull();
  });
});
