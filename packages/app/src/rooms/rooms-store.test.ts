import { describe, expect, it } from "vitest";
import type { RoomRecord } from "@getpaseo/protocol/room/types";
import {
  commitRoomUpdates,
  createRoomUpdateQueue,
  isRoomSnapshotNewer,
  useRoomsStore,
} from "@/rooms/rooms-store";

function buildRoom(overrides: Partial<RoomRecord> = {}): RoomRecord {
  return {
    id: "room_ab12",
    workspaceId: "ws_1",
    name: "Architecture review",
    topic: "Pick a message queue",
    status: "discussing",
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
    limits: { maxRounds: 6, maxTurns: 24, turnTimeoutMs: 900000, deltaCharBudget: 24000 },
    artifactPath: ".paseo/rooms/architecture-review/summary.md",
    summary: null,
    createdAt: "2026-10-23T10:00:00.000Z",
    updatedAt: "2026-10-23T10:00:00.000Z",
    closedAt: null,
    closedReason: null,
    ...overrides,
  };
}

interface QueuedTask {
  run: () => void;
}

function createManualQueue() {
  const commits: Array<Array<{ serverId: string; entry: RoomRecord }>> = [];
  const tasks: QueuedTask[] = [];
  const queue = createRoomUpdateQueue({
    commit: (updates) => {
      commits.push(
        updates.map((update) => ({ serverId: update.serverId, entry: update.entry.room })),
      );
    },
    schedule: (task) => {
      tasks.push({ run: task });
      return () => {};
    },
  });
  return {
    queue,
    commits,
    runScheduledFlush: () => {
      const pending = tasks.splice(0);
      for (const task of pending) task.run();
    },
  };
}

describe("isRoomSnapshotNewer", () => {
  it("treats a later updatedAt as newer", () => {
    const older = buildRoom({ updatedAt: "2026-10-23T10:00:00.000Z", lastSeq: 5 });
    const newer = buildRoom({ updatedAt: "2026-10-23T10:01:00.000Z", lastSeq: 3 });
    expect(isRoomSnapshotNewer(newer, older)).toBe(true);
    expect(isRoomSnapshotNewer(older, newer)).toBe(false);
  });

  it("breaks updatedAt ties on lastSeq", () => {
    const older = buildRoom({ updatedAt: "2026-10-23T10:00:00.000Z", lastSeq: 5 });
    const newer = buildRoom({ updatedAt: "2026-10-23T10:00:00.000Z", lastSeq: 6 });
    expect(isRoomSnapshotNewer(newer, older)).toBe(true);
    expect(isRoomSnapshotNewer(older, older)).toBe(false);
  });
});

describe("createRoomUpdateQueue", () => {
  it("drops an out-of-order snapshot that arrives after a newer one", () => {
    const { queue, commits, runScheduledFlush } = createManualQueue();
    const newer = buildRoom({ updatedAt: "2026-10-23T10:02:00.000Z", lastSeq: 9 });
    const older = buildRoom({ updatedAt: "2026-10-23T10:01:00.000Z", lastSeq: 8 });

    queue.enqueue("srv", newer, false);
    queue.enqueue("srv", older, false);
    runScheduledFlush();

    expect(commits).toEqual([[{ serverId: "srv", entry: newer }]]);
  });

  it("drops a duplicate snapshot with the same updatedAt and lastSeq", () => {
    const { queue, commits, runScheduledFlush } = createManualQueue();
    const first = buildRoom({ updatedAt: "2026-10-23T10:00:00.000Z", lastSeq: 7 });
    const duplicate = buildRoom({ updatedAt: "2026-10-23T10:00:00.000Z", lastSeq: 7 });

    queue.enqueue("srv", first, false);
    queue.enqueue("srv", duplicate, false);
    runScheduledFlush();

    expect(commits).toEqual([[{ serverId: "srv", entry: first }]]);
  });

  it("keeps only the latest snapshot per room within one flush window", () => {
    const { queue, commits, runScheduledFlush } = createManualQueue();
    const first = buildRoom({ updatedAt: "2026-10-23T10:00:00.000Z", lastSeq: 1 });
    const second = buildRoom({ updatedAt: "2026-10-23T10:00:01.000Z", lastSeq: 2 });
    const third = buildRoom({ updatedAt: "2026-10-23T10:00:02.000Z", lastSeq: 3 });

    queue.enqueue("srv", first, false);
    queue.enqueue("srv", second, false);
    queue.enqueue("srv", third, false);
    runScheduledFlush();

    expect(commits).toHaveLength(1);
    expect(commits[0]).toEqual([{ serverId: "srv", entry: third }]);
  });

  it("commits each scheduled window separately", () => {
    const { queue, commits, runScheduledFlush } = createManualQueue();
    const first = buildRoom({ updatedAt: "2026-10-23T10:00:00.000Z", lastSeq: 1 });
    const second = buildRoom({ updatedAt: "2026-10-23T10:00:01.000Z", lastSeq: 2 });

    queue.enqueue("srv", first, false);
    runScheduledFlush();
    queue.enqueue("srv", second, false);
    runScheduledFlush();

    expect(commits).toEqual([
      [{ serverId: "srv", entry: first }],
      [{ serverId: "srv", entry: second }],
    ]);
  });

  it("buckets rooms independently per server and room id", () => {
    const { queue, commits, runScheduledFlush } = createManualQueue();
    const roomA = buildRoom({ id: "room_a", lastSeq: 1 });
    const roomB = buildRoom({ id: "room_b", lastSeq: 1 });

    queue.enqueue("srv1", roomA, false);
    queue.enqueue("srv2", roomA, false);
    queue.enqueue("srv1", roomB, false);
    runScheduledFlush();

    expect(commits).toHaveLength(1);
    expect(commits[0]).toHaveLength(3);
  });
});

describe("rooms store state", () => {
  it("applies committed updates and keeps the newest snapshot", () => {
    useRoomsStore.setState({ roomsByServerId: {} });
    commitRoomUpdates([
      {
        serverId: "srv",
        roomId: "room_ab12",
        entry: {
          room: buildRoom({ lastSeq: 1, updatedAt: "2026-10-23T10:00:00.000Z" }),
          truncated: false,
        },
      },
    ]);

    expect(useRoomsStore.getState().roomsByServerId.srv?.room_ab12?.room.lastSeq).toBe(1);

    commitRoomUpdates([
      {
        serverId: "srv",
        roomId: "room_ab12",
        entry: {
          room: buildRoom({ lastSeq: 2, updatedAt: "2026-10-23T10:00:01.000Z" }),
          truncated: true,
        },
      },
    ]);

    const entry = useRoomsStore.getState().roomsByServerId.srv?.room_ab12;
    expect(entry?.room.lastSeq).toBe(2);
    expect(entry?.truncated).toBe(true);
  });

  it("does not let an older committed snapshot overwrite a newer one", () => {
    useRoomsStore.setState({
      roomsByServerId: {
        srv: {
          room_ab12: {
            room: buildRoom({ lastSeq: 5, updatedAt: "2026-10-23T10:05:00.000Z" }),
            truncated: false,
          },
        },
      },
    });
    commitRoomUpdates([
      {
        serverId: "srv",
        roomId: "room_ab12",
        entry: {
          room: buildRoom({ lastSeq: 4, updatedAt: "2026-10-23T10:04:00.000Z" }),
          truncated: false,
        },
      },
    ]);

    expect(useRoomsStore.getState().roomsByServerId.srv?.room_ab12?.room.lastSeq).toBe(5);
  });
});
