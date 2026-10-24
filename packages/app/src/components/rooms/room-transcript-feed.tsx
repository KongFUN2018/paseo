import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FlatList, Text, View, type FlatListProps } from "react-native";
import { File, Database, Image as ImageIcon, Table } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import type { RoomMember, RoomRecord, RoomTranscriptEntry } from "@getpaseo/protocol/room/types";
import { PressHighlight } from "@/components/ui/press-highlight";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import {
  fileBaseName,
  findAttachmentPaths,
  roomFileIconKind,
  roomFilesDirOf,
  splitCodeSegments,
  splitMentionSegments,
  type RoomFileIconKind,
} from "@/components/rooms/room-body";
import {
  memberLabel,
  roomMemberAvatarChar,
  roomMemberDisplayName,
  roomProviderModelLabel,
} from "@/components/rooms/room-members";
import { ROOM_AVATAR_FILL, roomNameStyle } from "@/components/rooms/room-identity-styles";
import { useRoomStreamEntries } from "@/rooms/room-stream-store";
import type { RoomFileEntry } from "@/rooms/rooms-query";
import { deriveIdentityColorName } from "@/styles/identity-colors";
import { formatMessageTimestamp } from "@/utils/time";

/** Local interjection rows rendered ahead of the daemon's transcript entry (§4.6). */
export interface PendingInterjection {
  localId: string;
  text: string;
  state: "pending" | "confirmed" | "error";
}

type FeedRow =
  | { type: "truncated"; key: string }
  | { type: "system"; key: string; entry: RoomTranscriptEntry }
  | { type: "moderatorCard"; key: string; entry: RoomTranscriptEntry }
  | { type: "member"; key: string; entry: RoomTranscriptEntry; cont: boolean }
  | { type: "interjection"; key: string; entry: RoomTranscriptEntry }
  | { type: "research"; key: string }
  | { type: "streaming"; key: string }
  | { type: "pending"; key: string; pending: PendingInterjection };

const ROUND_MARKER_PATTERN = /^round:(\d+)$/u;

function transcriptEntryRow(entry: RoomTranscriptEntry, cont: boolean): FeedRow {
  switch (entry.kind) {
    case "system":
      return { type: "system", key: `seq-${entry.seq}`, entry };
    case "opening":
    case "moderator":
      return { type: "moderatorCard", key: `seq-${entry.seq}`, entry };
    case "member":
      return { type: "member", key: `seq-${entry.seq}`, entry, cont };
    case "interjection":
      return { type: "interjection", key: `seq-${entry.seq}`, entry };
  }
}

function buildFeedRows(
  room: RoomRecord,
  truncated: boolean,
  streams: Record<string, { text: string; done: boolean }>,
  pendingInterjections: readonly PendingInterjection[],
): FeedRow[] {
  const rows: FeedRow[] = [];
  if (truncated && room.transcript.length > 0) {
    rows.push({ type: "truncated", key: "transcript-truncated" });
  }
  let previous: RoomTranscriptEntry | null = null;
  for (const entry of room.transcript) {
    // Consecutive statements from the same member merge (design §4.3); any
    // system, moderator or interjection entry between them breaks the group.
    const cont =
      entry.kind === "member" &&
      previous !== null &&
      previous.kind === "member" &&
      previous.memberId === entry.memberId;
    rows.push(transcriptEntryRow(entry, cont));
    previous = entry;
  }

  // Transient tail: research line, streaming row, optimistic interjections.
  const turnMemberId = room.turn.status === "speaking" ? room.turn.memberId : null;
  const stream = turnMemberId ? streams[turnMemberId] : undefined;
  if (turnMemberId && (!stream || (!stream.done && stream.text.length === 0))) {
    rows.push({ type: "research", key: "research" });
  }
  if (turnMemberId && stream && !stream.done && stream.text.length > 0) {
    rows.push({ type: "streaming", key: "streaming" });
  }
  for (const pending of pendingInterjections) {
    rows.push({ type: "pending", key: `pending-${pending.localId}`, pending });
  }
  return rows;
}

const FILE_ICONS: Record<RoomFileIconKind, typeof File> = {
  image: ImageIcon,
  table: Table,
  sql: Database,
  file: File,
};

function AttachmentChip({
  path,
  onOpenFile,
}: {
  path: string;
  onOpenFile: (path: string) => void;
}) {
  const { t } = useTranslation();
  const Icon = FILE_ICONS[roomFileIconKind(path)];
  const handlePress = useCallback(() => onOpenFile(path), [onOpenFile, path]);
  return (
    <PressHighlight
      style={styles.chip}
      onPress={handlePress}
      accessibilityLabel={t("rooms.files.openFile", { name: fileBaseName(path) })}
      testID={`room-attachment-${path}`}
    >
      <Icon size={14} color={styles.chipText.color} />
      <Text style={styles.chipText} numberOfLines={1}>
        {fileBaseName(path)}
      </Text>
    </PressHighlight>
  );
}

/** Statement body: plain text, pre-wrap, code segments never mention-matched. */
function MemberBody({
  text,
  displayNames,
  attachments,
  onOpenFile,
  streaming,
}: {
  text: string;
  displayNames: readonly string[];
  attachments: readonly string[];
  onOpenFile: (path: string) => void;
  streaming?: boolean;
}) {
  const body = useMemo(() => {
    const segments = splitCodeSegments(text);
    const parts: React.ReactNode[] = [];
    for (const segment of segments) {
      if (segment.code) {
        parts.push(<Text key={`code-${parts.length}`}>{segment.text}</Text>);
        continue;
      }
      for (const piece of splitMentionSegments(segment.text, displayNames)) {
        parts.push(
          piece.mention ? (
            <Text key={`m-${parts.length}`} style={styles.mention}>
              {piece.text}
            </Text>
          ) : (
            <Text key={`t-${parts.length}`}>{piece.text}</Text>
          ),
        );
      }
    }
    return parts;
  }, [displayNames, text]);
  return (
    <View style={styles.bodyColumn}>
      <Text style={styles.memberBody}>
        {body}
        {streaming ? <Text style={styles.cursor}>▍</Text> : null}
      </Text>
      {attachments.map((path) => (
        <AttachmentChip key={path} path={path} onOpenFile={onOpenFile} />
      ))}
    </View>
  );
}

function MemberAvatar({
  member,
  fallbackMemberId,
}: {
  member: RoomMember | null;
  fallbackMemberId: string;
}) {
  const colorName = deriveIdentityColorName(member?.id ?? fallbackMemberId);
  return (
    <View style={[styles.avatar, ROOM_AVATAR_FILL[colorName]]}>
      <Text style={styles.avatarChar}>
        {member ? roomMemberAvatarChar(member) : memberLabel(fallbackMemberId).slice(0, 1)}
      </Text>
    </View>
  );
}

const MemberRow = memo(function MemberRow({
  room,
  entry,
  cont,
  displayNames,
  files,
  roomFilesDir,
  onOpenFile,
  streamText,
  streaming,
  testID,
}: {
  room: RoomRecord;
  entry?: RoomTranscriptEntry;
  cont: boolean;
  displayNames: readonly string[];
  files: readonly RoomFileEntry[] | undefined;
  roomFilesDir: string;
  onOpenFile: (path: string) => void;
  /** Live streamed statement for the streaming row (no transcript entry yet). */
  streamText?: string;
  streaming?: boolean;
  testID: string;
}) {
  const memberId = entry?.memberId ?? room.turn.memberId ?? "";
  const member = room.members.find((candidate) => candidate.id === memberId) ?? null;
  const text = entry?.text ?? streamText ?? "";
  const attachments = useMemo(
    () => (streaming ? [] : findAttachmentPaths(text, files, roomFilesDir)),
    [files, roomFilesDir, streaming, text],
  );
  return (
    <View style={[styles.group, cont ? styles.groupCont : null]} testID={testID}>
      <View style={[styles.avatar, cont ? styles.avatarHidden : null]} pointerEvents="none">
        {!cont ? <MemberAvatar member={member} fallbackMemberId={memberId} /> : null}
      </View>
      <View style={styles.groupColumn}>
        {!cont ? (
          <View style={styles.who}>
            {member ? (
              <Text
                style={[roomNameStyle(deriveIdentityColorName(member.id)), styles.speakerName]}
                numberOfLines={1}
              >
                {roomMemberDisplayName(member)}
              </Text>
            ) : (
              <Text style={[styles.speakerName, styles.speakerNameMuted]} numberOfLines={1}>
                {memberId ? memberLabel(memberId) : "Member"}
              </Text>
            )}
            <Text style={styles.whoMeta} numberOfLines={1}>
              {member
                ? roomProviderModelLabel(member.provider, member.model)
                : roomProviderModelLabel(room.moderator.provider, room.moderator.model)}
            </Text>
            {entry ? (
              <Text style={styles.whoMeta}>{formatMessageTimestamp(new Date(entry.at))}</Text>
            ) : null}
          </View>
        ) : null}
        <MemberBody
          text={text}
          displayNames={displayNames}
          attachments={attachments}
          onOpenFile={onOpenFile}
          streaming={streaming}
        />
      </View>
    </View>
  );
});

function ModeratorCard({ entry }: { entry: RoomTranscriptEntry }) {
  const { t } = useTranslation();
  const who =
    entry.kind === "opening"
      ? t("rooms.transcript.moderatorOpening")
      : t("rooms.transcript.moderator");
  return (
    <View style={styles.moderatorCard} testID={`room-transcript-${entry.seq}`}>
      <Text style={styles.moderatorWho}>{who}</Text>
      <Text style={styles.moderatorText}>{entry.text}</Text>
    </View>
  );
}

function SystemRow({ entry }: { entry: RoomTranscriptEntry }) {
  const { t } = useTranslation();
  const roundMatch = ROUND_MARKER_PATTERN.exec(entry.text.trim());
  if (roundMatch) {
    return (
      <View style={styles.divider} testID={`room-transcript-${entry.seq}`}>
        <View style={styles.dividerLine} />
        <Text style={styles.dividerLabel}>
          {t("rooms.panel.round", { round: Number(roundMatch[1]) })}
        </Text>
        <View style={styles.dividerLine} />
      </View>
    );
  }
  return (
    <View style={styles.systemRow} testID={`room-transcript-${entry.seq}`}>
      <Text style={styles.systemText}>{entry.text}</Text>
    </View>
  );
}

function InterjectionRow({ entry }: { entry: RoomTranscriptEntry }) {
  const { t } = useTranslation();
  return (
    <View style={styles.interjectionRow} testID={`room-transcript-${entry.seq}`}>
      <View style={[styles.avatar, styles.youAvatar]}>
        <Text style={styles.youAvatarChar}>{t("rooms.transcript.you").slice(0, 1)}</Text>
      </View>
      <View style={styles.bubble}>
        <Text style={styles.bubbleText}>{entry.text}</Text>
      </View>
    </View>
  );
}

function PendingInterjectionRow({
  pending,
  onRetry,
  onDismiss,
}: {
  pending: PendingInterjection;
  onRetry: (localId: string) => void;
  onDismiss: (localId: string) => void;
}) {
  const { t } = useTranslation();
  const handleRetry = useCallback(() => onRetry(pending.localId), [onRetry, pending.localId]);
  const handleDismiss = useCallback(() => onDismiss(pending.localId), [onDismiss, pending.localId]);
  return (
    <View testID={`room-transcript-pending-${pending.localId}`}>
      <View style={styles.interjectionRow}>
        <View style={[styles.avatar, styles.youAvatar]}>
          <Text style={styles.youAvatarChar}>{t("rooms.transcript.you").slice(0, 1)}</Text>
        </View>
        <View style={[styles.bubble, pending.state === "error" ? styles.bubbleError : null]}>
          <Text style={styles.bubbleText}>{pending.text}</Text>
        </View>
      </View>
      {pending.state === "pending" || pending.state === "confirmed" ? (
        <Text style={styles.pendingMicro}>{t("rooms.transcript.sentPending")}</Text>
      ) : (
        <View style={styles.errorMicroRow}>
          <Text style={styles.errorMicro}>{t("rooms.transcript.sendFailed")}</Text>
          <PressHighlight
            onPress={handleRetry}
            accessibilityLabel={t("rooms.panel.retry")}
            hitSlop={8}
            testID={`room-interjection-retry-${pending.localId}`}
          >
            <Text style={styles.retryMicro}>{t("rooms.panel.retry")}</Text>
          </PressHighlight>
          <PressHighlight
            onPress={handleDismiss}
            accessibilityLabel={t("common.actions.dismiss")}
            hitSlop={8}
            testID={`room-interjection-dismiss-${pending.localId}`}
          >
            <Text style={styles.dismissMicro}>{t("common.actions.dismiss")}</Text>
          </PressHighlight>
        </View>
      )}
    </View>
  );
}

function ResearchRow({ room, toolCalls }: { room: RoomRecord; toolCalls: number }) {
  const { t } = useTranslation();
  const member = room.members.find((candidate) => candidate.id === room.turn.memberId) ?? null;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const startedAtMs = room.turn.startedAt ? new Date(room.turn.startedAt).getTime() : null;
  const seconds = startedAtMs !== null ? Math.max(0, Math.floor((now - startedAtMs) / 1000)) : 0;
  const name = member ? roomMemberDisplayName(member) : t("rooms.seat.moderator");
  const label = member?.catchUpPending
    ? t("rooms.panel.readingHistory", { name })
    : t("rooms.panel.researching", { name });
  return (
    <View style={styles.researchRow} testID="room-research-row">
      <LoadingSpinner size={12} color={styles.researchText.color} />
      <Text style={styles.researchText}>
        {label}
        {toolCalls > 0 ? ` · ${t("rooms.panel.toolCalls", { count: toolCalls })}` : ""} · {seconds}s
      </Text>
    </View>
  );
}

function TruncatedRow() {
  const { t } = useTranslation();
  return (
    <Text style={styles.truncated} testID="room-transcript-truncated">
      {t("rooms.transcript.olderNotLoaded")}
    </Text>
  );
}

const transcriptKeyExtractor = (item: FeedRow) => item.key;

export function RoomTranscriptFeed({
  room,
  serverId,
  truncated,
  active,
  pendingInterjections,
  files,
  onOpenFile,
  onRetryInterjection,
  onDismissInterjection,
}: {
  room: RoomRecord;
  serverId: string;
  truncated: boolean;
  /** Auto-scroll only runs while the panel is the active surface. */
  active: boolean;
  pendingInterjections: readonly PendingInterjection[];
  files: readonly RoomFileEntry[] | undefined;
  onOpenFile: (path: string) => void;
  onRetryInterjection: (localId: string) => void;
  onDismissInterjection: (localId: string) => void;
}) {
  const streams = useRoomStreamEntries(serverId, room.id);
  const displayNames = useMemo(
    () => room.members.map((member) => roomMemberDisplayName(member)),
    [room.members],
  );
  const roomFilesDir = useMemo(() => roomFilesDirOf(room.artifactPath), [room.artifactPath]);
  const rows = buildFeedRows(room, truncated, streams, pendingInterjections);
  const listRef = useRef<FlatList<FeedRow>>(null);
  const wasAtBottomRef = useRef(true);
  const lastSeqRef = useRef(room.lastSeq);
  const streamLengthRef = useRef(0);
  const pendingCountRef = useRef(0);

  const turnStream = room.turn.memberId ? streams[room.turn.memberId] : undefined;
  const streamLength = turnStream && !turnStream.done ? turnStream.text.length : 0;

  const renderRow = useCallback<NonNullable<FlatListProps<FeedRow>["renderItem"]>>(
    ({ item }) => {
      switch (item.type) {
        case "truncated":
          return <TruncatedRow />;
        case "system":
          return <SystemRow entry={item.entry} />;
        case "moderatorCard":
          return <ModeratorCard entry={item.entry} />;
        case "member":
          return (
            <MemberRow
              room={room}
              entry={item.entry}
              cont={item.cont}
              displayNames={displayNames}
              files={files}
              roomFilesDir={roomFilesDir}
              onOpenFile={onOpenFile}
              testID={`room-transcript-${item.entry.seq}`}
            />
          );
        case "interjection":
          return <InterjectionRow entry={item.entry} />;
        case "research":
          return (
            <ResearchRow
              room={room}
              toolCalls={room.turn.memberId ? (streams[room.turn.memberId]?.toolCalls ?? 0) : 0}
            />
          );
        case "streaming":
          return (
            <MemberRow
              room={room}
              cont={false}
              displayNames={displayNames}
              files={files}
              roomFilesDir={roomFilesDir}
              onOpenFile={onOpenFile}
              streamText={room.turn.memberId ? streams[room.turn.memberId]?.text : undefined}
              streaming
              testID="room-transcript-streaming"
            />
          );
        case "pending":
          return (
            <PendingInterjectionRow
              pending={item.pending}
              onRetry={onRetryInterjection}
              onDismiss={onDismissInterjection}
            />
          );
      }
    },
    [
      displayNames,
      files,
      onDismissInterjection,
      onOpenFile,
      onRetryInterjection,
      room,
      roomFilesDir,
      streams,
    ],
  );

  const handleScroll = useCallback<NonNullable<FlatListProps<FeedRow>["onScroll"]>>(
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
    const seqChanged = room.lastSeq !== lastSeqRef.current;
    const streamChanged = streamLength !== streamLengthRef.current;
    const pendingChanged = pendingInterjections.length !== pendingCountRef.current;
    if (!seqChanged && !streamChanged && !pendingChanged) {
      return;
    }
    lastSeqRef.current = room.lastSeq;
    streamLengthRef.current = streamLength;
    pendingCountRef.current = pendingInterjections.length;
    if (wasAtBottomRef.current) {
      listRef.current?.scrollToEnd({ animated: true });
    }
  }, [active, pendingInterjections.length, room.lastSeq, streamLength]);

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
  group: {
    flexDirection: "row",
    gap: theme.spacing[2],
    marginTop: theme.spacing[3],
    alignItems: "flex-start",
  },
  groupCont: {
    marginTop: theme.spacing[1],
  },
  groupColumn: {
    flex: 1,
    minWidth: 0,
    gap: theme.spacing[1],
  },
  avatar: {
    width: 28,
    height: 28,
    borderRadius: theme.borderRadius.full,
    alignItems: "center",
    justifyContent: "center",
  },
  avatarHidden: {
    opacity: 0,
  },
  avatarChar: {
    color: "#ffffff",
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  who: {
    flexDirection: "row",
    alignItems: "baseline",
    gap: theme.spacing[2],
  },
  speakerName: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  speakerNameMuted: {
    color: theme.colors.foregroundMuted,
  },
  whoMeta: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundExtraMuted,
  },
  bodyColumn: {
    gap: theme.spacing[1],
  },
  memberBody: {
    fontSize: theme.fontSize.content,
    lineHeight: Math.round(theme.fontSize.content * 1.55),
    color: theme.colors.foreground,
  },
  mention: {
    color: theme.colors.accentBright,
  },
  cursor: {
    color: theme.colors.foregroundMuted,
  },
  chip: {
    flexDirection: "row",
    alignItems: "center",
    alignSelf: "flex-start",
    gap: theme.spacing[1.5],
    minHeight: 32,
    paddingHorizontal: theme.spacing[2],
    borderRadius: theme.borderRadius.base,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
  },
  chipText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  moderatorCard: {
    alignSelf: "center",
    maxWidth: "86%",
    marginTop: theme.spacing[2],
    padding: theme.spacing[3],
    borderRadius: theme.borderRadius.lg,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
    gap: theme.spacing[1],
  },
  moderatorWho: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foregroundMuted,
  },
  moderatorText: {
    fontSize: theme.fontSize.base,
    lineHeight: Math.round(theme.fontSize.base * 1.6),
    color: theme.colors.foreground,
  },
  divider: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
    marginTop: theme.spacing[4],
    marginBottom: theme.spacing[1],
  },
  dividerLine: {
    flex: 1,
    height: 1,
    backgroundColor: theme.colors.border,
  },
  dividerLabel: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundExtraMuted,
  },
  systemRow: {
    marginTop: theme.spacing[2],
    alignItems: "center",
  },
  systemText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundExtraMuted,
    textAlign: "center",
  },
  interjectionRow: {
    flexDirection: "row-reverse",
    gap: theme.spacing[2],
    marginTop: theme.spacing[3],
    alignItems: "flex-start",
  },
  youAvatar: {
    backgroundColor: theme.colors.accent,
  },
  youAvatarChar: {
    color: "#ffffff",
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  bubble: {
    flexShrink: 1,
    maxWidth: "80%",
    backgroundColor: theme.colors.accent,
    borderRadius: theme.borderRadius.xl,
    borderBottomRightRadius: theme.borderRadius.sm,
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
  },
  bubbleError: {
    backgroundColor: theme.colors.statusDanger,
  },
  bubbleText: {
    fontSize: theme.fontSize.content,
    lineHeight: Math.round(theme.fontSize.content * 1.55),
    color: "#ffffff",
  },
  pendingMicro: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundExtraMuted,
    textAlign: "center",
    marginTop: theme.spacing[1],
  },
  errorMicroRow: {
    flexDirection: "row",
    justifyContent: "center",
    alignItems: "center",
    gap: theme.spacing[3],
    marginTop: theme.spacing[1],
  },
  errorMicro: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.statusDanger,
  },
  retryMicro: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
    fontWeight: theme.fontWeight.medium,
  },
  dismissMicro: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundExtraMuted,
  },
  researchRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingLeft: 38,
    paddingVertical: theme.spacing[1.5],
  },
  researchText: {
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
