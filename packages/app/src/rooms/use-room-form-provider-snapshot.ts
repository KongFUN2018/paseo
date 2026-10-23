import { useEffect } from "react";
import { useProvidersSnapshot } from "@/hooks/use-providers-snapshot";
import type { RoomFormModel } from "@/rooms/room-form-model";

/**
 * Async provider/model catalog input for the room form. The snapshot is
 * injected into the model; `connecting` is rendered as a loading state, never
 * an empty provider list.
 */
export function useRoomFormProviderSnapshot(model: RoomFormModel, serverId: string) {
  const snapshot = useProvidersSnapshot(serverId, { cwd: null });

  useEffect(() => {
    if (!snapshot.entries) {
      model.setProviderSnapshotStatus("connecting");
      return;
    }
    model.applyProviderSnapshot(snapshot.entries);
  }, [model, snapshot.entries]);

  return snapshot;
}
