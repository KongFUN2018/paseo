import { create } from "zustand";
import type { RoomRecord } from "@getpaseo/protocol/room/types";

export interface RoomStoreEntry {
  room: RoomRecord;
  /** True when the wire snapshot truncated the transcript (design §8.3). */
  truncated: boolean;
}

interface PendingRoomUpdate {
  serverId: string;
  roomId: string;
  entry: RoomStoreEntry;
}

export interface RoomUpdateQueue {
  enqueue(serverId: string, room: RoomRecord, truncated: boolean): void;
  flush(): void;
  dispose(): void;
}

export interface RoomsStoreState {
  roomsByServerId: Record<string, Record<string, RoomStoreEntry>>;
}

export const useRoomsStore = create<RoomsStoreState>(() => ({
  roomsByServerId: {},
}));

export function getRoomSnapshot(serverId: string, roomId: string): RoomStoreEntry | undefined {
  return useRoomsStore.getState().roomsByServerId[serverId]?.[roomId];
}

export function useRoomSnapshot(
  serverId: string | null,
  roomId: string,
): RoomStoreEntry | undefined {
  return useRoomsStore((state) =>
    serverId ? state.roomsByServerId[serverId]?.[roomId] : undefined,
  );
}

/**
 * Snapshots are full RoomRecords; the wire carries no deltas. A snapshot is a
 * successor only when it is newer than the incumbent by (updatedAt, lastSeq).
 * Same pair means the same snapshot — drop it instead of recommitting.
 */
export function isRoomSnapshotNewer(next: RoomRecord, prev: RoomRecord): boolean {
  if (next.updatedAt !== prev.updatedAt) {
    return next.updatedAt > prev.updatedAt;
  }
  return next.lastSeq > prev.lastSeq;
}

/** Apply already-deduplicated updates to the store. Only newer snapshots land. */
export function commitRoomUpdates(updates: readonly PendingRoomUpdate[]): void {
  useRoomsStore.setState((state) => {
    const accepted = updates.filter((update) => {
      const existing = state.roomsByServerId[update.serverId]?.[update.roomId];
      return !existing || isRoomSnapshotNewer(update.entry.room, existing.room);
    });
    if (accepted.length === 0) {
      return state;
    }
    const roomsByServerId = { ...state.roomsByServerId };
    for (const update of accepted) {
      const bucket = { ...roomsByServerId[update.serverId] };
      bucket[update.roomId] = update.entry;
      roomsByServerId[update.serverId] = bucket;
    }
    return { roomsByServerId };
  });
}

const ROOM_UPDATE_FLUSH_DELAY_MS = 16 * 3;

function scheduleRoomUpdateFlush(task: () => void): () => void {
  // A frame callback never fires in a hidden tab, so a timer races it and wins
  // when nothing is painting — the store keeps advancing either way.
  if (typeof requestAnimationFrame === "function") {
    let done = false;
    const frameId = requestAnimationFrame(() => {
      if (done) return;
      done = true;
      task();
    });
    const ceiling = setTimeout(() => {
      if (done) return;
      done = true;
      cancelAnimationFrame(frameId);
      task();
    }, ROOM_UPDATE_FLUSH_DELAY_MS);
    return () => {
      if (done) return;
      done = true;
      cancelAnimationFrame(frameId);
      clearTimeout(ceiling);
    };
  }
  const fallback = setTimeout(task, ROOM_UPDATE_FLUSH_DELAY_MS);
  return () => clearTimeout(fallback);
}

export function createRoomUpdateQueue(input: {
  commit: (updates: readonly PendingRoomUpdate[]) => void;
  schedule?: (task: () => void) => () => void;
}): RoomUpdateQueue {
  const schedule = input.schedule ?? scheduleRoomUpdateFlush;
  // One pending slot per room: room_update is a full snapshot, so latest-wins.
  const pendingByRoomKey = new Map<string, PendingRoomUpdate>();
  let cancelScheduledFlush: (() => void) | null = null;

  const flush = () => {
    cancelScheduledFlush?.();
    cancelScheduledFlush = null;
    if (pendingByRoomKey.size === 0) return;
    const updates = Array.from(pendingByRoomKey.values());
    pendingByRoomKey.clear();
    input.commit(updates);
  };

  return {
    enqueue(serverId, room, truncated) {
      const roomKey = `${serverId}:${room.id}`;
      const pending = pendingByRoomKey.get(roomKey);
      if (pending && !isRoomSnapshotNewer(room, pending.entry.room)) {
        return;
      }
      pendingByRoomKey.set(roomKey, {
        serverId,
        roomId: room.id,
        entry: { room, truncated },
      });
      if (!cancelScheduledFlush) {
        cancelScheduledFlush = schedule(() => {
          cancelScheduledFlush = null;
          flush();
        });
      }
    },
    flush,
    dispose() {
      cancelScheduledFlush?.();
      cancelScheduledFlush = null;
      pendingByRoomKey.clear();
    },
  };
}

let roomUpdateQueue: RoomUpdateQueue | null = null;

/** Session-level entry point: route a room_update push (or RPC snapshot) into the store. */
export function applyRoomUpdate(serverId: string, room: RoomRecord, truncated: boolean): void {
  roomUpdateQueue ??= createRoomUpdateQueue({ commit: commitRoomUpdates });
  roomUpdateQueue.enqueue(serverId, room, truncated);
}
