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
});
