import { describe, expect, test } from "vitest";
import { createTestLogger } from "../../../test-utils/test-logger.js";
import type { SessionOutboundMessage } from "../../messages.js";
import type { RoomService } from "../../room/service.js";
import { RoomSession, type RoomSessionHost } from "./room-session.js";

function makeHost() {
  const emitted: SessionOutboundMessage[] = [];
  const host: RoomSessionHost = {
    emit: (msg) => emitted.push(msg),
  };
  return { emitted, host };
}

function makeService(): RoomService {
  const base = {
    create: async () => {
      throw new Error("boom");
    },
  };
  return base as unknown as RoomService;
}

describe("RoomSession", () => {
  test("answers with rpc_error when the room service is unavailable", async () => {
    const { emitted, host } = makeHost();
    const session = new RoomSession({ host, roomService: null, logger: createTestLogger() });

    await session.handle({
      type: "room.list.request",
      requestId: "req-1",
    } as never);

    expect(emitted).toEqual([
      {
        type: "rpc_error",
        payload: {
          requestId: "req-1",
          requestType: "room.list.request",
          error: "Room service is unavailable on this daemon",
          code: "room_request_failed",
        },
      },
    ]);
  });

  test("routes handler failures to rpc_error with the original requestId", async () => {
    const { emitted, host } = makeHost();
    const session = new RoomSession({
      host,
      roomService: makeService(),
      logger: createTestLogger(),
    });

    await session.handle({
      type: "room.create.request",
      requestId: "req-2",
      workspaceId: "ws_1",
      name: "r",
      topic: "t",
      moderator: { provider: "codex" },
      members: [{ provider: "codex", persona: "p" }],
      artifactPath: "notes/summary.md",
    } as never);

    expect(emitted[0]).toMatchObject({
      type: "rpc_error",
      payload: {
        requestId: "req-2",
        requestType: "room.create.request",
        error: "boom",
        code: "room_request_failed",
      },
    });
  });

  test("passes member displayName and roleId through room.create to the service", async () => {
    const { emitted, host } = makeHost();
    const inputs: unknown[] = [];
    const room = { id: "room_1" };
    const service = {
      create: async (input: unknown) => {
        inputs.push(input);
        return room;
      },
    } as unknown as RoomService;
    const session = new RoomSession({ host, roomService: service, logger: createTestLogger() });

    await session.handle({
      type: "room.create.request",
      requestId: "req-5",
      workspaceId: "ws_1",
      name: "评审",
      topic: "选题",
      moderator: { provider: "codex" },
      members: [
        { provider: "codex", persona: "安全视角", displayName: "安全", roleId: "security" },
        { provider: "claude", persona: "可靠性视角" },
      ],
      artifactPath: "notes/summary.md",
    } as never);

    expect(emitted[0]).toMatchObject({
      type: "room.create.response",
      payload: { requestId: "req-5", roomId: "room_1", error: null },
    });
    // Identity fields reach RoomService.create; members without them stay clean.
    expect(inputs[0]).toMatchObject({
      members: [
        { provider: "codex", persona: "安全视角", displayName: "安全", roleId: "security" },
        { provider: "claude", persona: "可靠性视角" },
      ],
    });
  });

  test("dispatches room.member.add to the service and answers with the room", async () => {
    const { emitted, host } = makeHost();
    const inputs: unknown[] = [];
    const room = { id: "room_1" };
    const service = {
      addMember: async (roomId: string, input: unknown) => {
        inputs.push([roomId, input]);
        return room;
      },
    } as unknown as RoomService;
    const session = new RoomSession({ host, roomService: service, logger: createTestLogger() });

    await session.handle({
      type: "room.member.add.request",
      requestId: "req-3",
      roomId: "room_1",
      member: { provider: "codex", persona: "安全视角", displayName: "安全", roleId: "security" },
    } as never);

    expect(emitted[0]).toMatchObject({
      type: "room.member.add.response",
      payload: { requestId: "req-3", room, error: null },
    });
    expect(inputs[0]).toEqual([
      "room_1",
      {
        provider: "codex",
        model: null,
        modeId: null,
        persona: "安全视角",
        displayName: "安全",
        roleId: "security",
      },
    ]);
  });

  test("dispatches room.files.list to the service", async () => {
    const { emitted, host } = makeHost();
    const files = [
      { path: "notes/member_1/api.md", memberId: "member_1", sizeBytes: 6, updatedAtMs: 1 },
    ];
    const service = {
      listFiles: async () => files,
    } as unknown as RoomService;
    const session = new RoomSession({ host, roomService: service, logger: createTestLogger() });

    await session.handle({
      type: "room.files.list.request",
      requestId: "req-4",
      roomId: "room_1",
    } as never);

    expect(emitted[0]).toEqual({
      type: "room.files.list.response",
      payload: { requestId: "req-4", error: null, files },
    });
  });
});
