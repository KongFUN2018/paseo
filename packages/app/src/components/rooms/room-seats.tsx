import { memo, useCallback, useEffect, useMemo } from "react";
import { Text, View } from "react-native";
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from "react-native-reanimated";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import type { RoomMember, RoomRecord } from "@getpaseo/protocol/room/types";
import { PressHighlight } from "@/components/ui/press-highlight";
import {
  roomMemberAvatarChar,
  roomMemberDisplayName,
  roomProviderModelLabel,
} from "@/components/rooms/room-members";
import { ROOM_AVATAR_FILL, roomNameStyle } from "@/components/rooms/room-identity-styles";
import { useRoomStreamEntries, type RoomStreamEntry } from "@/rooms/room-stream-store";
import { deriveIdentityColorName, type IdentityColorName } from "@/styles/identity-colors";
import { StyleSheet as RNStyleSheet } from "react-native";

/** Visual bucket of a seat: drives the ring, the halo and the status color. */
type SeatVisual = "speaking" | "researching" | "failed" | "archived" | "idle";

interface SeatPresentation {
  statusText: string;
  visual: SeatVisual;
}

/** Fallback when the member is not in a live turn: plain snapshot status. */
function memberStatusPresentation(
  member: RoomMember,
  t: (key: string, options?: Record<string, unknown>) => string,
): SeatPresentation {
  if (member.status === "pending") {
    return { statusText: t("rooms.seat.pending"), visual: "idle" };
  }
  if (member.status === "speaking") {
    return { statusText: t("rooms.seat.speaking"), visual: "speaking" };
  }
  return { statusText: t("rooms.seat.ready"), visual: "idle" };
}

/**
 * Seat state machine (design §4.2). Everything derives from the room snapshot
 * plus the streaming store; the researching/speaking boundary is whether the
 * streamed statement already has text.
 */
function seatPresentation(
  member: RoomMember,
  room: RoomRecord,
  stream: RoomStreamEntry | undefined,
  t: (key: string, options?: Record<string, unknown>) => string,
): SeatPresentation {
  if (member.status === "failed") {
    return { statusText: t("rooms.seat.failed"), visual: "failed" };
  }
  if (member.status === "archived") {
    return { statusText: t("rooms.seat.archived"), visual: "archived" };
  }
  const isTurnMember = room.turn.memberId === member.id && room.turn.status !== "idle";
  if (isTurnMember && room.turn.status === "retrying") {
    return {
      statusText: t("rooms.panel.retrying", { attempt: room.turn.attempt + 1 }),
      visual: "researching",
    };
  }
  if (isTurnMember && room.turn.status === "preparing") {
    return { statusText: t("rooms.seat.preparing"), visual: "researching" };
  }
  const streamingText =
    isTurnMember &&
    room.turn.status === "speaking" &&
    stream !== undefined &&
    !stream.done &&
    stream.text.length > 0;
  // A member still reading the backlog only reads as speaking once its first
  // catch-up statement starts producing text (design §7.6).
  if (member.catchUpPending === true && !streamingText) {
    return { statusText: t("rooms.seat.catchingUp"), visual: "researching" };
  }
  if (isTurnMember && room.turn.status === "speaking") {
    if (streamingText) {
      return { statusText: t("rooms.seat.speaking"), visual: "speaking" };
    }
    if (!stream || !stream.done) {
      // Turn is live but no text has landed yet: researching (§4.2), which also
      // covers an old daemon that never pushes partials.
      return { statusText: t("rooms.seat.researching"), visual: "researching" };
    }
    // done:true landed; the next room_update moves the turn. Rest as ready.
    return { statusText: t("rooms.seat.ready"), visual: "idle" };
  }
  return memberStatusPresentation(member, t);
}

// Static per-color mappings were replaced by the shared roomIdentityStyles
// sheet, which tracks colorScheme through the Unistyles factory.

const BREATH_DURATION_MS = 800;
const SEAT_AVATAR_SIZE = 34;
const MODERATOR_AVATAR_SIZE = 28;

/** Breathing halo around the active speaker's avatar (prototype `pulse`). */
const SpeakingHalo = memo(function SpeakingHalo() {
  const progress = useSharedValue(1);
  useEffect(() => {
    progress.value = withRepeat(
      withTiming(0.2, { duration: BREATH_DURATION_MS, easing: Easing.inOut(Easing.ease) }),
      -1,
      true,
    );
    return () => {
      progress.value = 1;
    };
  }, [progress]);
  const animated = useAnimatedStyle(() => ({
    opacity: progress.value,
    transform: [{ scale: 1 + (1 - progress.value) * 0.2 }],
  }));
  // Reanimated owns the wrapper's plain styles; the theme-colored ring lives on
  // an inner View so Unistyles and Reanimated never patch the same node.
  return (
    <Animated.View pointerEvents="none" style={[haloStyles.position, animated]}>
      <View style={styles.haloRing} />
    </Animated.View>
  );
});

interface RoomSeatProps {
  name: string;
  avatarChar: string;
  colorName: IdentityColorName | null;
  providerModel: string | null;
  statusText: string | null;
  statusVisual: SeatVisual;
  isSpeaking: boolean;
  /** Turns already spoken, kept for the accessibility label. */
  turnCount: number | null;
  agentId: string | null;
  onOpenAgent: (agentId: string) => void;
  moderator?: boolean;
  testID: string;
}

/** Resolved at render so the Unistyles proxy stays lazy (never materialize at module scope). */
function seatStatusStyle(visual: SeatVisual) {
  switch (visual) {
    case "speaking":
      return styles.seatStatusSpeaking;
    case "researching":
      return styles.seatStatusResearching;
    case "failed":
      return styles.seatStatusFailed;
    case "archived":
      return styles.seatStatusArchived;
    default:
      return null;
  }
}

const RoomSeat = memo(function RoomSeat({
  name,
  avatarChar,
  colorName,
  providerModel,
  statusText,
  statusVisual,
  isSpeaking,
  turnCount,
  agentId,
  onOpenAgent,
  moderator = false,
  testID,
}: RoomSeatProps) {
  const { t } = useTranslation();
  const handlePress = useCallback(() => {
    if (agentId) {
      onOpenAgent(agentId);
    }
  }, [agentId, onOpenAgent]);
  const turnsSpoken = turnCount !== null ? t("rooms.seat.turnCount", { count: turnCount }) : null;
  const accessibilityLabel = [name, statusText, turnsSpoken].filter(Boolean).join(", ");
  return (
    <PressHighlight
      style={[styles.seat, isSpeaking ? styles.seatSpeaking : null]}
      onPress={agentId ? handlePress : undefined}
      disabled={!agentId}
      accessibilityLabel={accessibilityLabel}
      testID={testID}
    >
      <View style={styles.avatarWrap}>
        {isSpeaking ? <SpeakingHalo /> : null}
        {statusVisual === "researching" ? <View style={styles.researchRing} /> : null}
        <View
          style={[
            styles.avatar,
            moderator ? styles.avatarModerator : null,
            colorName ? ROOM_AVATAR_FILL[colorName] : null,
          ]}
        >
          <Text style={moderator ? styles.avatarCharModerator : styles.avatarChar}>
            {avatarChar}
          </Text>
        </View>
      </View>
      {colorName ? (
        <Text
          style={[roomNameStyle(colorName), isSpeaking ? styles.seatNameSpeaking : null]}
          numberOfLines={1}
        >
          {name}
        </Text>
      ) : (
        <Text style={[styles.seatName, styles.seatNameMuted]} numberOfLines={1}>
          {name}
        </Text>
      )}
      {providerModel ? (
        <Text style={styles.seatMeta} numberOfLines={1}>
          {providerModel}
        </Text>
      ) : null}
      {statusText ? (
        <Text style={[styles.seatStatus, seatStatusStyle(statusVisual)]} numberOfLines={1}>
          {statusText}
        </Text>
      ) : null}
    </PressHighlight>
  );
});

function AddSeat({ onPress, label }: { onPress: () => void; label: string }) {
  return (
    <PressHighlight
      style={styles.seat}
      onPress={onPress}
      accessibilityLabel={label}
      testID="room-seat-add"
    >
      <View style={styles.avatarWrap}>
        <View style={styles.addSeat}>
          <Text style={styles.addSeatChar}>＋</Text>
        </View>
      </View>
      <Text style={[styles.seatName, styles.seatNameMuted]} numberOfLines={1}>
        {label}
      </Text>
    </PressHighlight>
  );
}

export function RoomSeats({
  room,
  serverId,
  onOpenAgent,
  onAddMember,
}: {
  room: RoomRecord;
  serverId: string;
  onOpenAgent: (agentId: string) => void;
  onAddMember: () => void;
}) {
  const { t } = useTranslation();
  const streams = useRoomStreamEntries(serverId, room.id);
  // v1 rooms reject mid-room joins server-side (§7.2.1 third patch); hiding
  // the entry is guidance, the rpc_error stays authoritative.
  const canAddMember =
    (room.status === "discussing" || room.status === "interrupted") &&
    room.members.length < 4 &&
    room.promptVersion >= 2;

  const moderatorSeat = useMemo(
    () => (
      <RoomSeat
        name={t("rooms.seat.moderator")}
        avatarChar={t("rooms.seat.moderatorShort")}
        colorName={null}
        providerModel={roomProviderModelLabel(room.moderator.provider, room.moderator.model)}
        statusText={t("rooms.seat.moderatorRole")}
        statusVisual="idle"
        isSpeaking={false}
        turnCount={null}
        agentId={room.moderator.agentId}
        onOpenAgent={onOpenAgent}
        moderator
        testID="room-seat-moderator"
      />
    ),
    [onOpenAgent, room.moderator.agentId, room.moderator.model, room.moderator.provider, t],
  );

  return (
    <View style={styles.container} testID="room-seats">
      {room.members.map((member) => {
        const presentation = seatPresentation(member, room, streams[member.id], t);
        return (
          <RoomSeat
            key={member.id}
            name={roomMemberDisplayName(member)}
            avatarChar={roomMemberAvatarChar(member)}
            colorName={deriveIdentityColorName(member.id)}
            providerModel={roomProviderModelLabel(member.provider, member.model)}
            statusText={presentation.statusText}
            statusVisual={presentation.visual}
            isSpeaking={presentation.visual === "speaking"}
            turnCount={member.turnCount}
            agentId={member.agentId}
            onOpenAgent={onOpenAgent}
            testID={`room-seat-${member.id}`}
          />
        );
      })}
      {moderatorSeat}
      {canAddMember ? <AddSeat onPress={onAddMember} label={t("rooms.seat.invite")} /> : null}
    </View>
  );
}

// The geometry Reanimated patches stays in a plain RN stylesheet; every
// theme-dependent style lives in the Unistyles factory below.
const haloStyles = RNStyleSheet.create({
  position: {
    position: "absolute",
    width: SEAT_AVATAR_SIZE + 6,
    height: SEAT_AVATAR_SIZE + 6,
    alignItems: "center",
    justifyContent: "center",
  },
});

const styles = StyleSheet.create((theme) => ({
  container: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "center",
    flexWrap: "wrap",
    columnGap: theme.spacing[6],
    rowGap: theme.spacing[3],
    paddingVertical: theme.spacing[3],
    paddingHorizontal: theme.spacing[2],
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  seat: {
    alignItems: "center",
    gap: theme.spacing[1],
    minWidth: 64,
    minHeight: 44,
    paddingVertical: theme.spacing[1],
    borderRadius: theme.borderRadius.md,
  },
  seatSpeaking: {
    transform: [{ translateY: -2 }],
  },
  avatarWrap: {
    width: SEAT_AVATAR_SIZE,
    height: SEAT_AVATAR_SIZE,
    alignItems: "center",
    justifyContent: "center",
  },
  avatar: {
    width: SEAT_AVATAR_SIZE,
    height: SEAT_AVATAR_SIZE,
    borderRadius: theme.borderRadius.full,
    alignItems: "center",
    justifyContent: "center",
  },
  avatarModerator: {
    width: MODERATOR_AVATAR_SIZE,
    height: MODERATOR_AVATAR_SIZE,
    backgroundColor: theme.colors.surface3,
  },
  avatarChar: {
    color: "#ffffff",
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
  },
  avatarCharModerator: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  haloRing: {
    width: SEAT_AVATAR_SIZE + 4,
    height: SEAT_AVATAR_SIZE + 4,
    borderRadius: theme.borderRadius.full,
    borderWidth: 2,
    borderColor: theme.colors.statusDotRunning,
  },
  researchRing: {
    position: "absolute",
    width: SEAT_AVATAR_SIZE + 4,
    height: SEAT_AVATAR_SIZE + 4,
    borderRadius: theme.borderRadius.full,
    borderWidth: 2,
    borderColor: theme.colors.statusDotWarning,
  },
  addSeat: {
    width: SEAT_AVATAR_SIZE,
    height: SEAT_AVATAR_SIZE,
    borderRadius: theme.borderRadius.full,
    borderWidth: 1,
    borderStyle: "dashed",
    borderColor: theme.colors.surface4,
    alignItems: "center",
    justifyContent: "center",
  },
  addSeatChar: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
    lineHeight: theme.fontSize.base + 2,
  },
  seatName: {
    maxWidth: 88,
    fontSize: theme.fontSize.sm,
  },
  seatNameSpeaking: {
    fontWeight: theme.fontWeight.medium,
  },
  seatNameMuted: {
    color: theme.colors.foregroundMuted,
  },
  seatMeta: {
    maxWidth: 88,
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundExtraMuted,
  },
  seatStatus: {
    maxWidth: 96,
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundExtraMuted,
  },
  seatStatusSpeaking: {
    color: theme.colors.statusDotRunning,
  },
  seatStatusResearching: {
    color: theme.colors.statusWarning,
  },
  seatStatusFailed: {
    color: theme.colors.statusDanger,
  },
  seatStatusArchived: {
    color: theme.colors.foregroundExtraMuted,
  },
}));
