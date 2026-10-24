import type { QueryClient } from "@tanstack/react-query";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { RoomRecord, RoomSummary } from "@getpaseo/protocol/room/types";
import { useSessionStore } from "@/stores/session-store";
import { useFetchQuery } from "@/data/query";
import { i18n } from "@/i18n/i18next";
import { applyRoomUpdate } from "@/rooms/rooms-store";

export function roomsQueryKey(serverId: string): readonly ["rooms", string] {
  return ["rooms", serverId] as const;
}

export function roomQueryKey(serverId: string, roomId: string): readonly ["room", string, string] {
  return ["room", serverId, roomId] as const;
}

export function requireDaemonClient(serverId: string): DaemonClient {
  const client = useSessionStore.getState().sessions[serverId]?.client ?? null;
  if (!client) {
    throw new Error(i18n.t("common.errors.daemonClientUnavailable"));
  }
  return client;
}

function toRoomSummary(room: RoomRecord): RoomSummary {
  const { transcript: _transcript, interjections: _interjections, ...summary } = room;
  return summary;
}

/**
 * Keep the sidebar rooms list current from a room_update push. Rooms the list
 * has not seen are left alone — the list reload comes from room.list, not a
 * push for an unlisted room.
 */
export function upsertRoomIntoRoomsCache(
  queryClient: QueryClient,
  serverId: string,
  room: RoomRecord,
): void {
  queryClient.setQueryData<RoomSummary[] | undefined>(roomsQueryKey(serverId), (current) => {
    if (!current) return current;
    const index = current.findIndex((entry) => entry.id === room.id);
    if (index === -1) return current;
    const next = [...current];
    next[index] = toRoomSummary(room);
    return next;
  });
}

export interface UseRoomsResult {
  rooms: RoomSummary[];
  isLoading: boolean;
}

export function useRooms(serverId: string | null): UseRoomsResult {
  const query = useFetchQuery({
    queryKey: roomsQueryKey(serverId ?? ""),
    enabled: Boolean(serverId),
    queryFn: async (): Promise<RoomSummary[]> => {
      const client = requireDaemonClient(serverId ?? "");
      const payload = await client.roomList();
      if (payload.error) {
        throw new Error(payload.error);
      }
      return payload.rooms;
    },
    dataShape: "list",
    staleTimeMs: 5_000,
  });

  return {
    rooms: query.data ?? [],
    isLoading: query.isPending,
  };
}

export interface RoomQueryResult {
  room: RoomRecord | null;
  truncated: boolean;
}

/** Initial room.get fetch: caches the snapshot into the rooms store. */
export function useRoomQuery(serverId: string, roomId: string, enabled: boolean) {
  return useFetchQuery({
    queryKey: roomQueryKey(serverId, roomId),
    enabled,
    queryFn: async (): Promise<RoomQueryResult> => {
      const client = requireDaemonClient(serverId);
      const payload = await client.roomGet({ roomId });
      if (payload.error) {
        throw new Error(payload.error);
      }
      if (payload.room) {
        applyRoomUpdate(serverId, payload.room, payload.truncated ?? false);
      }
      return { room: payload.room, truncated: payload.truncated ?? false };
    },
    dataShape: "value",
    staleTimeMs: 5_000,
  });
}

export interface RoomFileEntry {
  /** Workspace-relative path, inside the room files directory. */
  path: string;
  /** Owning member; null means the moderator summary or a room-root file. */
  memberId: string | null;
  sizeBytes: number;
  updatedAtMs: number;
}

export function roomFilesQueryKey(
  serverId: string,
  roomId: string,
): readonly ["room-files", string, string] {
  return ["room-files", serverId, roomId] as const;
}

/**
 * Room artifacts for the files drawer and the transcript attachment chips
 * (design §8.3). Fetched when a room panel opens and refreshed whenever the
 * drawer opens.
 */
export function useRoomFilesQuery(serverId: string, roomId: string, enabled: boolean) {
  return useFetchQuery({
    queryKey: roomFilesQueryKey(serverId, roomId),
    enabled,
    queryFn: async (): Promise<RoomFileEntry[]> => {
      const client = requireDaemonClient(serverId);
      const payload = await client.roomFilesList({ roomId });
      if (payload.error) {
        throw new Error(payload.error);
      }
      return payload.files;
    },
    dataShape: "list",
    staleTimeMs: 10_000,
  });
}
