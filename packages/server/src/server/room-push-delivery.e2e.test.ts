import { afterAll, expect, test } from "vitest";
import { WebSocket } from "ws";
import { DaemonClient } from "./test-utils/daemon-client.js";
import type { WSOutboundMessage } from "./messages.js";
import { createTestPaseoDaemon } from "./test-utils/paseo-daemon.js";

const daemons: Array<{ close: () => Promise<void> }> = [];
afterAll(async () => {
  for (const d of daemons) await d.close();
});

class Peer {
  readonly frames: WSOutboundMessage[] = [];
  constructor(private readonly socket: WebSocket) {
    socket.on("message", (data) => {
      if (!data.toString) return;
      this.frames.push(JSON.parse(data.toString()));
    });
  }
  static async connect(port: number, clientId: string): Promise<Peer> {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const peer = new Peer(socket);
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });
    socket.send(
      JSON.stringify({
        type: "hello",
        clientType: "browser",
        clientId,
        protocolVersion: 1,
        appVersion: "0.14.0",
        capabilities: { owned_subscriptions: true },
      }),
    );
    await expect
      .poll(() =>
        peer.frames.some(
          (f) =>
            f.type === "session" &&
            f.message.type === "status" &&
            (f.message.payload as { status?: string }).status === "server_info",
        ),
      )
      .toBe(true);
    peer.frames.length = 0;
    return peer;
  }
  close() {
    this.socket.terminate();
  }
}

test("a modern GUI client receives room_update broadcasts", async () => {
  const daemon = await createTestPaseoDaemon({ mcpEnabled: false });
  daemons.push(daemon);
  const modern = await Peer.connect(daemon.port, "modern-room-peer");

  const admin = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws`, appVersion: "0.14.0" });
  await admin.connect();
  const agent = await admin.createAgent({
    provider: "codex",
    cwd: daemon.staticDir,
    title: "room host ws",
  });
  const workspaceId = agent.workspaceId;
  expect(workspaceId).toBeTruthy();

  const created = await admin.roomCreate({
    workspaceId: workspaceId!,
    name: "e2e room",
    topic: "t",
    moderator: { provider: "codex" },
    members: [
      { provider: "codex", persona: "p1" },
      { provider: "codex", persona: "p2" },
    ],
    artifactPath: "notes/summary.md",
  });
  expect(created.error ?? null).toBeNull();
  const roomId = created.roomId;
  expect(roomId).toBeTruthy();

  await admin.roomStart({ roomId: roomId! });

  await expect
    .poll(
      () =>
        modern.frames.filter((f) => f.type === "session" && f.message.type === "room_update")
          .length,
      { timeout: 10000 },
    )
    .toBeGreaterThan(0);

  // The start transition lands as a room_update push on the modern socket.
  const pushes = modern.frames.filter(
    (f) => f.type === "session" && f.message.type === "room_update",
  );
  expect(pushes.length).toBeGreaterThan(0);
  const room = (pushes.at(-1) as { message: { payload: { room: { id: string } } } }).message.payload
    .room;
  expect(room.id).toBe(roomId);
  modern.close();
  await admin.close();
}, 45000);
