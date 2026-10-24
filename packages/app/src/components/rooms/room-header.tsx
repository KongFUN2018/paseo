import { useMemo } from "react";
import { Text, View } from "react-native";
import { Archive, Flag, Loader, MessageCircle, PauseCircle, PlayCircle } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import type { LucideIcon } from "lucide-react-native";
import { StyleSheet } from "react-native-unistyles";
import type { RoomRecord, RoomStatus } from "@getpaseo/protocol/room/types";
import { ScreenTitle } from "@/components/headers/screen-title";
import { StatusBadge, type StatusBadgeVariant } from "@/components/ui/status-badge";
import { roomMemberDisplayName } from "@/components/rooms/room-members";

export interface RoomStatusPresentation {
  label: string;
  badgeVariant: StatusBadgeVariant;
  Icon: LucideIcon;
}

export function roomStatusTranslationKey(status: RoomStatus): string {
  switch (status) {
    case "forming":
      return "rooms.status.forming";
    case "opening":
      return "rooms.status.opening";
    case "discussing":
      return "rooms.status.discussing";
    case "closing":
      return "rooms.status.closing";
    case "interrupted":
      return "rooms.status.interrupted";
    case "closed":
      return "rooms.status.closed";
  }
}

export function useRoomStatusPresentation(status: RoomStatus): RoomStatusPresentation {
  const { t } = useTranslation();
  return useMemo(() => {
    switch (status) {
      case "forming":
        return { label: t("rooms.status.forming"), badgeVariant: "muted", Icon: PlayCircle };
      case "opening":
        return { label: t("rooms.status.opening"), badgeVariant: "warning", Icon: Loader };
      case "discussing":
        return {
          label: t("rooms.status.discussing"),
          badgeVariant: "success",
          Icon: MessageCircle,
        };
      case "closing":
        return { label: t("rooms.status.closing"), badgeVariant: "warning", Icon: Flag };
      case "interrupted":
        return { label: t("rooms.status.interrupted"), badgeVariant: "error", Icon: PauseCircle };
      case "closed":
        return { label: t("rooms.status.closed"), badgeVariant: "muted", Icon: Archive };
    }
  }, [status, t]);
}

export function RoomHeader({ room, actions }: { room: RoomRecord; actions: React.ReactNode }) {
  const status = useRoomStatusPresentation(room.status);
  const BadgeIcon = status.Icon;
  const badgeIconColor = styles.badgeIcon.color;
  const badgeLeading = useMemo(
    () => <BadgeIcon size={12} color={badgeIconColor} />,
    [BadgeIcon, badgeIconColor],
  );
  return (
    <View style={styles.container}>
      <View style={styles.titleRow}>
        <View style={styles.titleBlock}>
          <ScreenTitle numberOfLines={1} testID="room-panel-title">
            {room.name}
          </ScreenTitle>
          <StatusBadge
            label={status.label}
            variant={status.badgeVariant}
            leading={badgeLeading}
            size="xs"
          />
        </View>
        {actions}
      </View>
      <Text style={styles.topic} numberOfLines={2}>
        {room.topic}
      </Text>
    </View>
  );
}

function turnStatusLabel(
  room: RoomRecord,
  speakingMember: RoomRecord["members"][number],
  streamHasText: boolean,
  streamDone: boolean,
  t: (key: string, options?: Record<string, unknown>) => string,
): string {
  if (room.turn.status === "retrying") {
    return t("rooms.panel.retrying", { attempt: room.turn.attempt + 1 });
  }
  if (room.turn.status === "preparing") {
    return t("rooms.panel.preparing", { name: roomMemberDisplayName(speakingMember) });
  }
  if (room.turn.status === "speaking") {
    // Aligned with the seat state machine: after the terminal flush settles
    // the stream, the speaker reads as ready instead of flashing "researching"
    // in the window before the next room_update moves the turn (§12 race).
    if (streamDone) {
      return t("rooms.seat.ready");
    }
    if (!streamHasText) {
      return speakingMember.catchUpPending
        ? t("rooms.panel.readingHistory", { name: roomMemberDisplayName(speakingMember) })
        : t("rooms.panel.researching", { name: roomMemberDisplayName(speakingMember) });
    }
  }
  return t("rooms.panel.speaking", { name: roomMemberDisplayName(speakingMember) });
}

/**
 * Seatline under the seats (design §3.1/§6.5): round + live speaker state.
 * Moderator pointings stay implicit — the wire carries no per-turn pointing
 * signal, so the seatline only states facts the snapshots prove.
 */
export function RoomSeatline({
  room,
  streamHasText,
  streamDone,
}: {
  room: RoomRecord;
  /** Whether the streamed statement of the current speaker already has text. */
  streamHasText: boolean;
  /** Whether the terminal flush (done:true) has settled the live stream. */
  streamDone: boolean;
}) {
  const { t } = useTranslation();
  const speakingMember = room.members.find((member) => member.id === room.turn.memberId) ?? null;
  const parts: string[] = [];
  if (room.status === "discussing" || room.status === "interrupted" || room.status === "opening") {
    parts.push(t("rooms.panel.round", { round: room.round.index }));
  }
  if (speakingMember) {
    parts.push(turnStatusLabel(room, speakingMember, streamHasText, streamDone, t));
  }
  if (room.status === "closing") {
    parts.push(t("rooms.panel.awaitingClose"));
  }
  if (room.status === "interrupted") {
    parts.push(t("rooms.panel.interruptedNoSpend"));
  }
  if (parts.length === 0) {
    return null;
  }
  return (
    <Text style={styles.statusBar} testID="room-seatline">
      {parts.join(" · ")}
    </Text>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    gap: theme.spacing[1.5],
  },
  titleRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[3],
    minHeight: 32,
  },
  titleBlock: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
    flexShrink: 1,
  },
  topic: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  statusBar: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  badgeIcon: {
    color: theme.colors.foregroundMuted,
  },
}));
