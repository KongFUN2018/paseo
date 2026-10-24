import { useEffect, useState, useSyncExternalStore } from "react";
import {
  openRoomMemberAddForm,
  type RoomMemberAddFormModel,
  type RoomMemberAddFormState,
} from "@/rooms/room-member-add-form-model";

/** Model lifetime adapter: one form model per mount, destroyed on unmount. */
export function useRoomMemberAddFormModel() {
  const [model] = useState(() => openRoomMemberAddForm());

  useEffect(() => {
    return () => {
      model.close();
    };
  }, [model]);

  const state = useSyncExternalStore(
    (listener) => model.subscribe(listener),
    () => model.getState(),
  );

  return { model, state } satisfies {
    model: RoomMemberAddFormModel;
    state: RoomMemberAddFormState;
  };
}
