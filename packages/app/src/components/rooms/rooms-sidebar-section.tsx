import { useCallback, useMemo, useState } from "react";
import { Text, View } from "react-native";
import { Plus } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import type { RoomSummary } from "@getpaseo/protocol/room/types";
import { SidebarSectionHeader } from "@/components/sidebar/sidebar-section-header";
import { RoomFormSheet } from "@/components/rooms/room-form-sheet";
import { roomStatusTranslationKey } from "@/components/rooms/room-header";
import { PressHighlight } from "@/components/ui/press-highlight";
import { useHostFeature } from "@/runtime/host-features";
import {
  navigateToWorkspace,
  useActiveWorkspaceSelection,
  useLastWorkspaceSelection,
} from "@/stores/navigation-active-workspace-store";
import { useRooms } from "@/rooms/rooms-query";

/**
 * Rooms section in the workspace sidebar. The whole section renders only when
 * the daemon advertises `features.room` — an old daemon shows no entry point.
 */
export function RoomsSidebarSection() {
  const { t } = useTranslation();
  const activeSelection = useActiveWorkspaceSelection();
  const lastSelection = useLastWorkspaceSelection();
  const selection = activeSelection ?? lastSelection;
  const serverId = selection?.serverId ?? null;
  const workspaceId = selection?.workspaceId ?? null;
  const supportsRooms = useHostFeature(serverId, "room");
  const [formOpen, setFormOpen] = useState(false);
  // The design requires a fresh form on every open (§6.3): bumping this key
  // remounts the sheet, discarding the previous draft and submit error.
  const [formEpoch, setFormEpoch] = useState(0);
  const { rooms } = useRooms(supportsRooms ? serverId : null);

  // Closed rooms keep their history and stay reachable, but they no longer
  // belong in the working list: they piled up between live rooms and made the
  // section look like it could not be cleaned up. One collapsed group at the
  // bottom keeps them one click away without crowding the list.
  const [archiveCollapsed, setArchiveCollapsed] = useState(true);
  const toggleArchive = useCallback(() => {
    setArchiveCollapsed((collapsed) => !collapsed);
  }, []);
  const activeRooms = useMemo(() => rooms.filter((room) => room.status !== "closed"), [rooms]);
  const archivedRooms = useMemo(() => rooms.filter((room) => room.status === "closed"), [rooms]);

  const openRoom = useCallback(
    (room: RoomSummary) => {
      if (!serverId) {
        return;
      }
      navigateToWorkspace({
        serverId,
        workspaceId: room.workspaceId,
        target: { kind: "room", roomId: room.id },
      });
    },
    [serverId],
  );
  const handleOpenForm = useCallback(() => {
    if (workspaceId) {
      setFormEpoch((epoch) => epoch + 1);
      setFormOpen(true);
    }
  }, [workspaceId]);
  const handleCreated = useCallback(
    (roomId: string) => {
      setFormOpen(false);
      if (serverId && workspaceId) {
        navigateToWorkspace({
          serverId,
          workspaceId,
          target: { kind: "room", roomId },
        });
      }
    },
    [serverId, workspaceId],
  );
  const handleCloseForm = useCallback(() => {
    setFormOpen(false);
  }, []);
  const newRoomIconColor = styles.newRoomIcon.color;

  if (!supportsRooms || !serverId) {
    return null;
  }

  return (
    <View testID="sidebar-rooms-section">
      <SidebarSectionHeader title={t("rooms.sidebar.title")}>
        <PressHighlight
          onPress={handleOpenForm}
          accessibilityLabel={t("rooms.sidebar.newRoom")}
          hitSlop={8}
          disabled={!workspaceId}
          testID="sidebar-rooms-new"
        >
          <Plus size={14} color={newRoomIconColor} />
        </PressHighlight>
      </SidebarSectionHeader>
      {activeRooms.map((room) => (
        <RoomSummaryRow key={room.id} room={room} onPress={openRoom} />
      ))}
      {archivedRooms.length > 0 ? (
        <View testID="sidebar-rooms-archive">
          <SidebarSectionHeader
            title={t("rooms.sidebar.archived", { count: archivedRooms.length })}
            collapsed={archiveCollapsed}
            onToggle={toggleArchive}
            testID="sidebar-rooms-archive-toggle"
          />
          {archiveCollapsed
            ? null
            : archivedRooms.map((room) => (
                <RoomSummaryRow key={room.id} room={room} onPress={openRoom} />
              ))}
        </View>
      ) : null}
      <RoomFormSheet
        key={formEpoch}
        visible={formOpen}
        serverId={serverId}
        workspaceId={workspaceId}
        onCreated={handleCreated}
        onClose={handleCloseForm}
      />
    </View>
  );
}

function RoomSummaryRow({
  room,
  onPress,
}: {
  room: RoomSummary;
  onPress: (room: RoomSummary) => void;
}) {
  const { t } = useTranslation();
  const handlePress = useCallback(() => {
    onPress(room);
  }, [onPress, room]);
  const subtitle = useMemo(() => {
    const statusLabel = t(roomStatusTranslationKey(room.status));
    if (room.status === "discussing") {
      return `${statusLabel} · ${t("rooms.sidebar.round", { round: room.round.index })}`;
    }
    return `${statusLabel} · ${t("rooms.sidebar.updated", {
      time: new Date(room.updatedAt).toLocaleTimeString(),
    })}`;
  }, [room.round.index, room.status, room.updatedAt, t]);

  return (
    <PressHighlight
      style={styles.row}
      onPress={handlePress}
      accessibilityLabel={room.name}
      testID={`sidebar-room-${room.id}`}
    >
      <Text style={styles.rowTitle} numberOfLines={1}>
        {room.name}
      </Text>
      <Text style={styles.rowSubtitle} numberOfLines={1}>
        {subtitle}
      </Text>
    </PressHighlight>
  );
}

const styles = StyleSheet.create((theme) => ({
  newRoomIcon: {
    color: theme.colors.foregroundMuted,
  },
  row: {
    paddingVertical: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    borderRadius: theme.borderRadius.lg,
    gap: 2,
    minHeight: 44,
  },
  rowTitle: {
    fontSize: theme.fontSize.base,
    color: theme.colors.foreground,
  },
  rowSubtitle: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
}));
