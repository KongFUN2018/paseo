import { useEffect, useState, useSyncExternalStore } from "react";
import { openRoomForm, type RoomFormModel, type RoomFormState } from "@/rooms/room-form-model";

export function useRoomFormModel() {
  const [model] = useState(() => openRoomForm());

  useEffect(() => {
    return () => {
      model.close();
    };
  }, [model]);

  const state = useSyncExternalStore(
    (listener) => model.subscribe(listener),
    () => model.getState(),
  );

  return { model, state } satisfies { model: RoomFormModel; state: RoomFormState };
}
