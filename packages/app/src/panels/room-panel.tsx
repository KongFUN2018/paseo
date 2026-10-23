import invariant from "tiny-invariant";
import { useCallback } from "react";
import { MessageSquarePlus } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { usePaneContext } from "@/panels/pane-context";
import { definePanel } from "@/panels/panel-registry";
import { RoomPanelContent } from "@/components/rooms/room-panel-content";
import { roomStatusTranslationKey } from "@/components/rooms/room-header";
import { useRoomSnapshot } from "@/rooms/rooms-store";

function RoomPanel() {
  const { serverId, target, openTab } = usePaneContext();
  invariant(target.kind === "room", "RoomPanel requires a room target");
  const handleOpenAgent = useCallback(
    (agentId: string) => {
      openTab({ kind: "agent", agentId });
    },
    [openTab],
  );

  return (
    <RoomPanelContent serverId={serverId} roomId={target.roomId} onOpenAgent={handleOpenAgent} />
  );
}
function useRoomPanelDescriptor(
  target: { kind: "room"; roomId: string },
  context: { serverId: string },
) {
  const { t } = useTranslation();
  const snapshot = useRoomSnapshot(context.serverId, target.roomId);
  return {
    label: snapshot?.room.name ?? t("rooms.panel.defaultTitle"),
    subtitle: snapshot ? t(roomStatusTranslationKey(snapshot.room.status)) : "",
    tooltip: snapshot?.room.name ?? t("rooms.panel.defaultTitle"),
    titleState: snapshot ? ("ready" as const) : ("loading" as const),
    icon: MessageSquarePlus,
    statusBucket: null,
  };
}

export const roomPanelRegistration = definePanel("room", {
  component: RoomPanel,
  useDescriptor: useRoomPanelDescriptor,
});
