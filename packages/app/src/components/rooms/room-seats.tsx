import { memo, useCallback, useMemo } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import type { RoomMember, RoomRecord, RoomTurnStatus } from "@getpaseo/protocol/room/types";
import { PressHighlight } from "@/components/ui/press-highlight";
import { memberLabel } from "@/components/rooms/room-header";

function seatStatusText(
  member: RoomMember,
  turnStatus: RoomTurnStatus,
  turnAttempt: number,
  isActive: boolean,
  t: (key: string, options?: Record<string, unknown>) => string,
): string {
  if (isActive && turnStatus === "retrying") {
    return t("rooms.panel.retrying", { attempt: turnAttempt + 1 });
  }
  if (isActive && turnStatus === "speaking") {
    return t("rooms.seat.speaking");
  }
  if (isActive && turnStatus === "preparing") {
    return t("rooms.seat.preparing");
  }
  switch (member.status) {
    case "pending":
      return t("rooms.seat.pending");
    case "ready":
      return t("rooms.seat.ready");
    case "speaking":
      return t("rooms.seat.speaking");
    case "failed":
      return t("rooms.seat.failed");
    case "archived":
      return t("rooms.seat.archived");
  }
}

interface RoomSeatProps {
  label: string;
  providerModel: string;
  persona: string | null;
  statusText: string;
  turnCount: number | null;
  isActive: boolean;
  agentId: string | null;
  onOpenAgent: (agentId: string) => void;
  testID: string;
}

const RoomSeat = memo(function RoomSeat({
  label,
  providerModel,
  persona,
  statusText,
  turnCount,
  isActive,
  agentId,
  onOpenAgent,
  testID,
}: RoomSeatProps) {
  const { t } = useTranslation();
  const handlePress = useCallback(() => {
    if (agentId) {
      onOpenAgent(agentId);
    }
  }, [agentId, onOpenAgent]);
  const turnsSpoken = turnCount !== null ? t("rooms.seat.turnCount", { count: turnCount }) : null;
  const accessibilityLabel = `${label}, ${statusText}${turnsSpoken ? `, ${turnsSpoken}` : ""}`;
  return (
    <PressHighlight
      style={[styles.seat, isActive ? styles.seatActive : null]}
      onPress={handlePress}
      accessibilityLabel={accessibilityLabel}
      testID={testID}
    >
      <Text style={styles.seatTitle} numberOfLines={1}>
        {label}
      </Text>
      <Text style={styles.seatMeta} numberOfLines={1}>
        {providerModel}
      </Text>
      {persona ? (
        <Text style={styles.seatMeta} numberOfLines={1}>
          {persona}
        </Text>
      ) : null}
      <Text style={isActive ? styles.seatStatusActive : styles.seatStatus} numberOfLines={1}>
        {statusText}
      </Text>
      {turnsSpoken ? (
        <Text style={styles.seatMeta} numberOfLines={1}>
          {turnsSpoken}
        </Text>
      ) : null}
    </PressHighlight>
  );
});

export function RoomSeats({
  room,
  onOpenAgent,
}: {
  room: RoomRecord;
  onOpenAgent: (agentId: string) => void;
}) {
  const { t } = useTranslation();
  const moderatorModel = useMemo(
    () =>
      room.moderator.model
        ? `${room.moderator.provider} / ${room.moderator.model}`
        : room.moderator.provider,
    [room.moderator.model, room.moderator.provider],
  );

  return (
    <View style={styles.container} testID="room-seats">
      {room.members.map((member) => {
        const isActive = room.turn.memberId === member.id;
        const providerModel = member.model
          ? `${member.provider} / ${member.model}`
          : member.provider;
        return (
          <RoomSeat
            key={member.id}
            label={memberLabel(member.id)}
            providerModel={providerModel}
            persona={member.persona.trim() || null}
            statusText={seatStatusText(member, room.turn.status, room.turn.attempt, isActive, t)}
            turnCount={member.turnCount}
            isActive={isActive}
            agentId={member.agentId}
            onOpenAgent={onOpenAgent}
            testID={`room-seat-${member.id}`}
          />
        );
      })}
      <RoomSeat
        label={t("rooms.seat.moderator")}
        providerModel={moderatorModel}
        persona={null}
        statusText={t("rooms.seat.moderatorRole")}
        turnCount={null}
        isActive={false}
        agentId={room.moderator.agentId}
        onOpenAgent={onOpenAgent}
        testID="room-seat-moderator"
      />
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    flexDirection: "row",
    gap: theme.spacing[2],
    flexWrap: "wrap",
  },
  seat: {
    flexBasis: 140,
    flexGrow: 1,
    gap: theme.spacing[1],
    padding: theme.spacing[3],
    borderRadius: theme.borderRadius.lg,
    borderWidth: 1,
    borderColor: theme.colors.border,
    minHeight: 44,
  },
  seatActive: {
    borderColor: theme.colors.statusDotRunning,
  },
  seatTitle: {
    fontSize: theme.fontSize.base,
    color: theme.colors.foreground,
  },
  seatMeta: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  seatStatus: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  seatStatusActive: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
  },
}));
