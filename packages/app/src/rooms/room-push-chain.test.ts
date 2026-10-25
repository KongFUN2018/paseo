import { afterEach, expect, test } from "vitest";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { DaemonTransport } from "@getpaseo/client/internal/daemon-client-transport-types";
import type { SessionOutboundMessage } from "@getpaseo/protocol/messages";
import { handleRoomPartialPush } from "@/rooms/room-push";
import {
  clearRoomStreams,
  getRoomStreamEntry,
  useRoomStreamStore,
} from "@/rooms/room-stream-store";

const clients: DaemonClient[] = [];

afterEach(async () => {
  await Promise.all(clients.map((client) => client.close()));
  clients.length = 0;
  clearRoomStreams("srv_test", "room_1");
});

function createMockTransport() {
  let onMessage: (data: unknown) => void = () => {};
  let onOpen: () => void = () => {};
  const transport: DaemonTransport = {
    send: (data) => {
      const frame = typeof data === "string" ? (JSON.parse(data) as { type?: string }) : null;
      if (frame?.type === "ping") onMessage(JSON.stringify({ type: "pong" }));
    },
    close: () => {},
    onMessage: (handler) => {
      onMessage = (data) => handler(data, typeof data !== "string");
      return () => {};
    },
    onOpen: (handler) => {
      onOpen = handler;
      return () => {};
    },
    onClose: () => () => {},
    onError: () => () => {},
  };
  return {
    transport,
    triggerOpen: () => {
      onOpen();
      onMessage(
        JSON.stringify({
          type: "session",
          message: {
            type: "status",
            payload: {
              status: "server_info",
              serverId: "srv_test",
              hostname: null,
              version: null,
              features: { ownedSubscriptions: true },
            },
          },
        }),
      );
    },
    deliverSessionMessage: (message: SessionOutboundMessage) => {
      onMessage(JSON.stringify({ type: "session", message }));
    },
  };
}

/**
 * Chain regression (2026-10-24 acceptance P1): a room_partial_update arriving
 * on the wire must flow — client dispatch → session-context's handler → the
 * stream store — so the streaming row and the seat presentation get data.
 * Drives a real DaemonClient over a mock transport and registers the same
 * subscription session-context installs.
 */
test("room_partial_update flows from the client entry into the stream store", async () => {
  const mock = createMockTransport();
  const client = new DaemonClient({
    url: "ws://test",
    clientId: "room_partial_store_chain_test",
    transportFactory: () => mock.transport,
    reconnect: { enabled: false },
  });
  clients.push(client);

  client.on("room_partial_update", (message) => handleRoomPartialPush("srv_test", message));

  const connectPromise = client.connect();
  mock.triggerOpen();
  await connectPromise;

  expect(useRoomStreamStore.getState().byRoomKey["srv_test:room_1"]).toBeUndefined();

  mock.deliverSessionMessage({
    type: "room_partial_update",
    payload: {
      roomId: "room_1",
      memberId: "member_1",
      text: "正在流式",
      toolCalls: 1,
      done: false,
    },
  });

  const entries = useRoomStreamStore.getState().byRoomKey["srv_test:room_1"];
  expect(entries?.member_1).toMatchObject({
    text: "正在流式",
    toolCalls: 1,
    done: false,
  });

  // The same view the feed and seats subscribe to: the entry lives under the
  // serverId:roomId key, keyed by memberId (getRoomStreamEntry mirrors the
  // useRoomStreamEntries selector without needing a renderer).
  expect(getRoomStreamEntry("srv_test", "room_1", "member_1")?.text).toBe("正在流式");
  expect(getRoomStreamEntry("srv_other", "room_1", "member_1")).toBeUndefined();
});
