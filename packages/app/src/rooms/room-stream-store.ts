import { create } from "zustand";

/**
 * In-progress member statement, streamed in as `room_partial_update` pushes
 * (design §6.5). Partials are transient — they never enter the rooms store or
 * trigger a full room snapshot churn; the seats and the transcript feed
 * subscribe here directly.
 */
export interface RoomStreamEntry {
  /** Accumulated snapshot of the statement so far, NOT a delta. */
  text: string;
  toolCalls: number;
  /**
   * Set by the terminal flush. A done entry is kept (not deleted) so the seat
   * of a member who just finished does not flash "researching" in the window
   * between `done:true` and the `room_update` that moves the turn (§12 race);
   * consumers hide rows and settle the seat on it. A later non-done partial
   * for the same member (their next turn) resets the entry.
   */
  done: boolean;
  updatedAt: number;
}

interface RoomStreamState {
  /** `serverId:roomId` → `memberId` → in-progress statement. */
  byRoomKey: Record<string, Record<string, RoomStreamEntry>>;
}

export const useRoomStreamStore = create<RoomStreamState>(() => ({
  byRoomKey: {},
}));

const MAX_STREAM_TEXT_LENGTH = 8000;

function roomKey(serverId: string, roomId: string): string {
  return `${serverId}:${roomId}`;
}

/** Session-level entry point: route a room_partial_update push into the store. */
export function applyRoomPartial(input: {
  serverId: string;
  roomId: string;
  memberId: string;
  text: string;
  toolCalls: number;
  done: boolean;
}): void {
  const key = roomKey(input.serverId, input.roomId);
  useRoomStreamStore.setState((state) => {
    const room = state.byRoomKey[key];
    const previous = room?.[input.memberId];
    // text is an accumulated snapshot: no re-accumulation, no ordering state.
    const text = input.text.slice(0, MAX_STREAM_TEXT_LENGTH);
    const next: RoomStreamEntry = {
      text,
      toolCalls: input.toolCalls,
      done: input.done,
      updatedAt: previous && !input.done ? previous.updatedAt : Date.now(),
    };
    if (
      previous &&
      previous.text === next.text &&
      previous.toolCalls === next.toolCalls &&
      previous.done === next.done
    ) {
      return state;
    }
    return {
      byRoomKey: {
        ...state.byRoomKey,
        [key]: { ...room, [input.memberId]: next },
      },
    };
  });
}

export function getRoomStreamEntry(
  serverId: string,
  roomId: string,
  memberId: string,
): RoomStreamEntry | undefined {
  return useRoomStreamStore.getState().byRoomKey[roomKey(serverId, roomId)]?.[memberId];
}

/** Drop every partial for one room (room closed, panel unmounted, tests). */
export function clearRoomStreams(serverId: string, roomId: string): void {
  const key = roomKey(serverId, roomId);
  useRoomStreamStore.setState((state) => {
    if (!state.byRoomKey[key]) {
      return state;
    }
    const byRoomKey = { ...state.byRoomKey };
    delete byRoomKey[key];
    return { byRoomKey };
  });
}

// One frozen empty snapshot for every "no partials yet" answer. A selector
// returning a fresh `{}` on each call makes React see an unstable getSnapshot
// and re-render forever: zustand v5 feeds the selector to useSyncExternalStore.
const EMPTY_ENTRIES: Record<string, RoomStreamEntry> = Object.freeze({});

export function useRoomStreamEntries(
  serverId: string | null,
  roomId: string,
): Record<string, RoomStreamEntry> {
  return useRoomStreamStore((state) =>
    serverId ? (state.byRoomKey[roomKey(serverId, roomId)] ?? EMPTY_ENTRIES) : EMPTY_ENTRIES,
  );
}
