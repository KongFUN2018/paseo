import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import type { RoomCheckpoint, RoomRecord } from "@getpaseo/protocol/room/types";
import { Button } from "@/components/ui/button";
import { LoadingSpinner } from "@/components/ui/loading-spinner";

function checkpointLabel(checkpoint: RoomCheckpoint, t: (key: string) => string): string {
  switch (checkpoint) {
    case "opening":
      return t("rooms.checkpoint.opening");
    case "round_end":
      return t("rooms.checkpoint.roundEnd");
    case "interjection":
      return t("rooms.checkpoint.interjection");
    case "summary":
      return t("rooms.checkpoint.summary");
  }
}

/** The moderator is deciding (or has decided) the next step; no model reasoning is shown. */
export function RoomCheckpointCard({ room }: { room: RoomRecord }) {
  const { t } = useTranslation();
  const checkpoint = room.pendingCheckpoint ?? null;
  if (!checkpoint) {
    return null;
  }
  return (
    <View style={styles.card} testID="room-checkpoint-card">
      <LoadingSpinner size={14} color={styles.hint.color} />
      <Text style={styles.title}>{checkpointLabel(checkpoint, t)}</Text>
    </View>
  );
}

export function RoomClosingCard({
  room,
  onContinue,
  onClose,
  closePending,
}: {
  room: RoomRecord;
  /** Focuses the composer: continuing means sending an interjection, which needs text. */
  onContinue: () => void;
  onClose: () => void;
  closePending: boolean;
}) {
  const { t } = useTranslation();
  if (room.status !== "closing") {
    return null;
  }
  return (
    <View style={styles.card} testID="room-closing-card">
      <Text style={styles.cardTitle}>{t("rooms.closing.title")}</Text>
      {room.summary ? <Text style={styles.summary}>{room.summary}</Text> : null}
      <Text style={styles.hint}>
        {t("rooms.closing.artifactPath", { path: room.artifactPath })}
      </Text>
      <View style={styles.actions}>
        <Button
          variant="default"
          size="md"
          onPress={onContinue}
          disabled={closePending}
          testID="room-continue-discussion"
        >
          {t("rooms.actions.continueDiscussion")}
        </Button>
        <Button
          variant="outline"
          size="md"
          onPress={onClose}
          disabled={closePending}
          loading={closePending}
          testID="room-close-from-closing"
        >
          {t("rooms.actions.close")}
        </Button>
      </View>
    </View>
  );
}

export function RoomInterruptedCard({
  room,
  onResume,
  onClose,
  resumePending,
  closePending,
}: {
  room: RoomRecord;
  onResume: () => void;
  onClose: () => void;
  resumePending: boolean;
  closePending: boolean;
}) {
  const { t } = useTranslation();
  if (room.status !== "interrupted") {
    return null;
  }
  return (
    <View style={styles.card} testID="room-interrupted-card">
      <Text style={styles.cardTitle}>{t("rooms.interrupted.title")}</Text>
      <Text style={styles.hint}>{t("rooms.panel.interruptedNoSpend")}</Text>
      <View style={styles.actions}>
        <Button
          variant="default"
          size="md"
          onPress={onResume}
          disabled={resumePending || closePending}
          loading={resumePending}
          testID="room-resume"
        >
          {t("rooms.actions.resume")}
        </Button>
        <Button
          variant="outline"
          size="md"
          onPress={onClose}
          disabled={resumePending || closePending}
          loading={closePending}
          testID="room-close-from-interrupted"
        >
          {t("rooms.actions.close")}
        </Button>
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  card: {
    gap: theme.spacing[2],
    padding: theme.spacing[3],
    borderRadius: theme.borderRadius.lg,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  cardTitle: {
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foreground,
  },
  title: {
    fontSize: theme.fontSize.base,
    color: theme.colors.foreground,
  },
  summary: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
  },
  hint: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  actions: {
    flexDirection: "row",
    gap: theme.spacing[2],
  },
}));
