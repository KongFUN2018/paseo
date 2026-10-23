import { memo, useCallback, useEffect, useRef } from "react";
import { FlatList, Text, View, type FlatListProps } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import type { RoomRecord, RoomTranscriptEntry } from "@getpaseo/protocol/room/types";
import { capAssistantMessageForRender } from "@/components/assistant-message-render-limit";
import { MarkdownRenderer } from "@/components/markdown/renderer";
import { isWeb } from "@/constants/platform";
import { memberLabel } from "@/components/rooms/room-header";

type TranscriptRow =
  | { type: "truncated"; key: string }
  | { type: "entry"; key: string; entry: RoomTranscriptEntry };

function buildTranscriptRows(room: RoomRecord, truncated: boolean): TranscriptRow[] {
  const rows: TranscriptRow[] = [];
  if (truncated && room.transcript.length > 0) {
    rows.push({ type: "truncated", key: "transcript-truncated" });
  }
  for (const entry of room.transcript) {
    rows.push({ type: "entry", key: `seq-${entry.seq}`, entry });
  }
  return rows;
}

function entrySpeakerLabel(entry: RoomTranscriptEntry): string | null {
  if (entry.kind === "member") {
    return entry.memberId ? memberLabel(entry.memberId) : "Member";
  }
  if (entry.kind === "moderator") {
    return "Moderator";
  }
  if (entry.kind === "interjection") {
    return null;
  }
  return null;
}

const RoomTranscriptRow = memo(function RoomTranscriptRow({
  entry,
}: {
  entry: RoomTranscriptEntry;
}) {
  const { t } = useTranslation();
  const speaker = entrySpeakerLabel(entry);
  // Web caps a single rendered markdown body; native keeps the full text.
  const text = isWeb ? capAssistantMessageForRender(entry.text).text : entry.text;

  if (entry.kind === "interjection") {
    return (
      <View style={styles.interjectionRow} testID={`room-transcript-${entry.seq}`}>
        <Text style={styles.interjectionSpeaker}>{t("rooms.transcript.you")}</Text>
        <MarkdownRenderer text={text} compact />
      </View>
    );
  }
  if (entry.kind === "system") {
    return (
      <View style={styles.systemRow} testID={`room-transcript-${entry.seq}`}>
        <Text style={styles.systemText}>{text}</Text>
      </View>
    );
  }
  return (
    <View style={styles.row} testID={`room-transcript-${entry.seq}`}>
      <Text style={styles.speaker}>{speaker}</Text>
      <MarkdownRenderer text={text} compact />
    </View>
  );
});

function TruncatedRow() {
  const { t } = useTranslation();
  return (
    <Text style={styles.truncated} testID="room-transcript-truncated">
      {t("rooms.transcript.olderNotLoaded")}
    </Text>
  );
}

const transcriptKeyExtractor = (item: TranscriptRow) => item.key;

export function RoomTranscriptFeed({
  room,
  truncated,
  active,
}: {
  room: RoomRecord;
  truncated: boolean;
  /** Auto-scroll only runs while the panel is the active surface. */
  active: boolean;
}) {
  const rows = buildTranscriptRows(room, truncated);
  const listRef = useRef<FlatList<TranscriptRow>>(null);
  const wasAtBottomRef = useRef(true);
  const lastSeqRef = useRef(room.lastSeq);

  const renderRow = useCallback<NonNullable<FlatListProps<TranscriptRow>["renderItem"]>>(
    ({ item }) => {
      if (item.type === "truncated") {
        return <TruncatedRow />;
      }
      return <RoomTranscriptRow entry={item.entry} />;
    },
    [],
  );

  const handleScroll = useCallback<NonNullable<FlatListProps<TranscriptRow>["onScroll"]>>(
    ({ nativeEvent }) => {
      const { contentOffset, contentSize, layoutMeasurement } = nativeEvent;
      const distanceFromEnd = contentSize.height - layoutMeasurement.height - contentOffset.y;
      wasAtBottomRef.current = distanceFromEnd < 80;
    },
    [],
  );

  useEffect(() => {
    if (!active) {
      return;
    }
    if (room.lastSeq !== lastSeqRef.current) {
      lastSeqRef.current = room.lastSeq;
      if (wasAtBottomRef.current) {
        listRef.current?.scrollToEnd({ animated: true });
      }
    }
  }, [active, room.lastSeq]);

  return (
    <FlatList
      ref={listRef}
      data={rows}
      renderItem={renderRow}
      keyExtractor={transcriptKeyExtractor}
      onScroll={handleScroll}
      scrollEventThrottle={120}
      initialNumToRender={12}
      maxToRenderPerBatch={10}
      windowSize={8}
      testID="room-transcript-feed"
    />
  );
}

const styles = StyleSheet.create((theme) => ({
  row: {
    gap: theme.spacing[1],
    paddingVertical: theme.spacing[2],
  },
  speaker: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foregroundMuted,
  },
  interjectionRow: {
    gap: theme.spacing[1],
    paddingVertical: theme.spacing[2],
    padding: theme.spacing[3],
    borderRadius: theme.borderRadius.lg,
    backgroundColor: theme.colors.surface2,
    alignSelf: "flex-start",
    minWidth: 120,
    maxWidth: "100%",
  },
  interjectionSpeaker: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foregroundMuted,
  },
  systemRow: {
    paddingVertical: theme.spacing[2],
  },
  systemText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  truncated: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
    paddingVertical: theme.spacing[2],
    textAlign: "center",
  },
}));
