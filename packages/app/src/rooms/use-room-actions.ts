import { useCallback } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { RoomRecord } from "@getpaseo/protocol/room/types";
import { requireDaemonClient, roomsQueryKey } from "@/rooms/rooms-query";
import { applyRoomUpdate } from "@/rooms/rooms-store";

export type RoomActionName = "start" | "pause" | "resume" | "interject" | "close" | "reopen";

export interface UseRoomActionsResult {
  startRoom: () => Promise<void>;
  pauseRoom: () => Promise<void>;
  resumeRoom: () => Promise<void>;
  /** Resolves with the RPC payload so the caller can reconcile optimistic rows. */
  interject: (text: string) => Promise<RoomMutationPayload>;
  closeRoom: () => Promise<void>;
  reopenRoom: () => Promise<void>;
  pendingAction: RoomActionName | null;
  actionError: string | null;
  dismissActionError: () => void;
}

interface RoomMutationPayload {
  requestId: string;
  room: RoomRecord | null;
  error: string | null;
}

interface MutationStatus {
  isPending: boolean;
  error: unknown;
  reset(): void;
}

/**
 * Room mutations share one pending slot: the action that fired stays disabled
 * while its RPC is in flight, and one in-page error line reports the failure.
 */
export function useRoomActions(serverId: string, roomId: string): UseRoomActionsResult {
  const queryClient = useQueryClient();

  const settle = useCallback(
    async (payload: RoomMutationPayload): Promise<RoomMutationPayload> => {
      if (payload.error) {
        throw new Error(payload.error);
      }
      if (payload.room) {
        applyRoomUpdate(serverId, payload.room, false);
        void queryClient.invalidateQueries({ queryKey: roomsQueryKey(serverId) });
      }
      return payload;
    },
    [queryClient, serverId],
  );

  const startMutation = useMutation({
    mutationFn: async () => {
      const client = requireDaemonClient(serverId);
      return settle(await client.roomStart({ roomId }));
    },
  });
  const pauseMutation = useMutation({
    mutationFn: async () => {
      const client = requireDaemonClient(serverId);
      return settle(await client.roomPause({ roomId }));
    },
  });
  const resumeMutation = useMutation({
    mutationFn: async () => {
      const client = requireDaemonClient(serverId);
      return settle(await client.roomResume({ roomId }));
    },
  });
  const closeMutation = useMutation({
    mutationFn: async () => {
      const client = requireDaemonClient(serverId);
      return settle(await client.roomClose({ roomId }));
    },
  });
  const reopenMutation = useMutation({
    mutationFn: async () => {
      const client = requireDaemonClient(serverId);
      return settle(await client.roomReopen({ roomId }));
    },
  });
  const interjectMutation = useMutation({
    mutationFn: async (text: string) => {
      const client = requireDaemonClient(serverId);
      return settle(await client.roomInterject({ roomId, text }));
    },
  });

  const mutations: Array<[RoomActionName, MutationStatus]> = [
    ["start", startMutation],
    ["pause", pauseMutation],
    ["resume", resumeMutation],
    ["close", closeMutation],
    ["reopen", reopenMutation],
    ["interject", interjectMutation],
  ];

  const pendingMutation = mutations.find(([, mutation]) => mutation.isPending) ?? null;
  const pendingAction: RoomActionName | null = pendingMutation?.[0] ?? null;
  const failedMutation = mutations.find(([, mutation]) => mutation.error != null) ?? null;
  const actionError = failedMutation?.[1].error ?? null;

  const dismissActionError = () => {
    for (const [, mutation] of mutations) {
      mutation.reset();
    }
  };

  return {
    startRoom: async () => {
      await startMutation.mutateAsync(undefined);
    },
    pauseRoom: async () => {
      await pauseMutation.mutateAsync(undefined);
    },
    resumeRoom: async () => {
      await resumeMutation.mutateAsync(undefined);
    },
    interject: async (text: string) => {
      return interjectMutation.mutateAsync(text);
    },
    closeRoom: async () => {
      await closeMutation.mutateAsync(undefined);
    },
    reopenRoom: async () => {
      await reopenMutation.mutateAsync(undefined);
    },
    pendingAction,
    actionError: actionError instanceof Error ? actionError.message : null,
    dismissActionError,
  };
}
