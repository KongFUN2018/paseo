import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { RoomRecord } from "@getpaseo/protocol/room/types";
import { createTestLogger } from "../../test-utils/test-logger.js";
import { RoomStore, generateRoomId } from "./store.js";

function makeRoom(overrides: Partial<RoomRecord> = {}): Omit<RoomRecord, "id"> & { id?: string } {
  return {
    workspaceId: "ws_1",
    name: "架构评审",
    topic: "选题",
    status: "forming",
    promptVersion: 1,
    moderator: { agentId: null, provider: "claude", model: null, modeId: null },
    members: [],
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
    artifactPath: ".paseo/rooms/x/summary.md",
    summary: null,
    createdAt: "2026-10-21T00:00:00.000Z",
    updatedAt: "2026-10-21T00:00:00.000Z",
    closedAt: null,
    closedReason: null,
    ...overrides,
  };
}

describe("RoomStore", () => {
  let tempDir: string;
  let store: RoomStore;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "room-store-test-"));
    store = new RoomStore(tempDir, createTestLogger());
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  test("writes one file per room and reloads it", async () => {
    const created = await store.create(makeRoom());

    expect(created.id).toMatch(/^room_[0-9a-f]{8}$/);

    const reloaded = new RoomStore(tempDir, createTestLogger());
    expect(await reloaded.get(created.id)).toEqual(created);
    expect(await reloaded.list()).toEqual([created]);
  });

  test("returns null for a missing room", async () => {
    expect(await store.get("room_missing")).toBeNull();
  });

  test("serializes concurrent updates to the same room", async () => {
    const created = await store.create(makeRoom());
    const bump = (room: { name: string }) => ({ ...room, name: `${room.name}+` });

    await Promise.all(Array.from({ length: 5 }, () => store.update(created.id, bump)));

    const final = await store.get(created.id);
    expect(final?.name).toBe("架构评审+++++");
  });

  test("skips an invalid room file, logs it once, and lists the rest", async () => {
    const created = await store.create(makeRoom({ name: "good" }));
    await writeFile(join(tempDir, "room_broken.json"), "{not json", "utf-8");

    const fresh = new RoomStore(tempDir, createTestLogger());
    expect((await fresh.list()).map((room) => room.id)).toEqual([created.id]);
  });

  test("rejects an update that changes the room id", async () => {
    const created = await store.create(makeRoom());

    await expect(
      store.update(created.id, (room) => ({ ...room, id: "room_other" })),
    ).rejects.toThrow(/cannot change id/);
  });

  test("deletes a room file", async () => {
    const created = await store.create(makeRoom());
    await store.delete(created.id);

    expect(await store.get(created.id)).toBeNull();
  });

  test("generates distinct room ids", () => {
    expect(generateRoomId()).not.toBe(generateRoomId());
  });
});
