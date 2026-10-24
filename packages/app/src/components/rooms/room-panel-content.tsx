import { useCallback, useMemo, useRef, useState, type ReactNode } from "react";
import { Text, View } from "react-native";
import { Paperclip } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { KeyboardAvoidingView } from "react-native-keyboard-controller";
import { StyleSheet } from "react-native-unistyles";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { useRetainedPanelActive } from "@/components/retained-panel";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { PressHighlight } from "@/components/ui/press-highlight";
import { RoomHeader, RoomSeatline } from "@/components/rooms/room-header";
import { RoomSeats } from "@/components/rooms/room-seats";
import { RoomFilesDrawer } from "@/components/rooms/room-files-drawer";
import { RoomMemberAddSheet } from "@/components/rooms/room-member-add-sheet";
import {
  RoomFailureCard,
  RoomPermissionCard,
  RoomReconnectAlert,
} from "@/components/rooms/room-notice-region";
import {
  RoomTranscriptFeed,
  type PendingInterjection,
} from "@/components/rooms/room-transcript-feed";
import {
  RoomCheckpointCard,
  RoomClosingCard,
  RoomInterruptedCard,
} from "@/components/rooms/room-cards";
import {
  RoomInterjectionComposer,
  type RoomInterjectionComposerHandle,
} from "@/components/rooms/room-interjection-composer";
import { useRoomActions } from "@/rooms/use-room-actions";
import { useRoomFilesQuery, useRoomQuery } from "@/rooms/rooms-query";
import { useRoomSnapshot } from "@/rooms/rooms-store";
import { useRoomStreamEntries } from "@/rooms/room-stream-store";
import { confirmDialog } from "@/utils/confirm-dialog";

export interface RoomPanelContentProps {
  serverId: string;
  roomId: string;
  onOpenAgent: (agentId: string) => void;
  onOpenFile: (path: string) => void;
}

/** Local optimistic interjection row, reconciled by interjectionId (§4.6). */
interface LocalInterjection extends PendingInterjection {
  interjectionId?: string;
}

export function RoomPanelContent({
  serverId,
  roomId,
  onOpenAgent,
  onOpenFile,
}: RoomPanelContentProps) {
  const { t } = useTranslation();
  const isPanelActive = useRetainedPanelActive();
  const client = useHostRuntimeClient(serverId);
  const isConnected = useHostRuntimeIsConnected(serverId);
  const roomQuery = useRoomQuery(serverId, roomId, Boolean(client));
  const snapshot = useRoomSnapshot(serverId, roomId);
  const actions = useRoomActions(serverId, roomId);
  const filesQuery = useRoomFilesQuery(serverId, roomId, Boolean(client));
  const streams = useRoomStreamEntries(serverId, roomId);
  const composerRef = useRef<RoomInterjectionComposerHandle>(null);

  // Optimistic interjections (§4.6): rendered immediately, reconciled against
  // transcript entries by the interjectionId echoed in the RPC response.
  const [localInterjections, setLocalInterjections] = useState<LocalInterjection[]>([]);
  const localInterjectionCounter = useRef(0);
  const [filesDrawerOpen, setFilesDrawerOpen] = useState(false);
  const [memberAddSheet, setMemberAddSheet] = useState<{ key: number } | null>(null);

  const focusComposer = useCallback(() => {
    composerRef.current?.focus();
  }, []);

  const handleRetry = useCallback(() => {
    roomQuery.refetch();
  }, [roomQuery]);

  const handleOpenAgent = useCallback(
    (agentId: string) => {
      onOpenAgent(agentId);
    },
    [onOpenAgent],
  );

  const openFilesDrawer = useCallback(() => {
    setFilesDrawerOpen(true);
    void filesQuery.refetch();
  }, [filesQuery]);

  const closeFilesDrawer = useCallback(() => {
    setFilesDrawerOpen(false);
  }, []);

  const openMemberAddSheet = useCallback(() => {
    setMemberAddSheet({ key: Date.now() });
  }, []);

  const closeMemberAddSheet = useCallback(() => {
    setMemberAddSheet(null);
  }, []);

  const submitInterjection = useCallback(
    async (text: string, existingLocalId?: string) => {
      const localId = existingLocalId ?? `local-${++localInterjectionCounter.current}`;
      setLocalInterjections((prev) => [
        ...prev.filter((row) => row.localId !== localId),
        { localId, text, state: "pending" },
      ]);
      try {
        const payload = await actions.interject(text);
        // The daemon echoes the room; our interjection is its newest entry
        // (§4.6). The row flips to confirmed and disappears once the
        // transcript entry with that id arrives via room_update.
        const interjections = payload.room?.interjections ?? [];
        const latest = interjections.reduce<RoomInterjectionLike | null>(
          (acc, candidate) =>
            acc === null || acc.createdAt < candidate.createdAt ? candidate : acc,
          null,
        );
        setLocalInterjections((prev) =>
          prev.map((row) =>
            row.localId === localId
              ? { ...row, state: "confirmed", interjectionId: latest?.id ?? row.interjectionId }
              : row,
          ),
        );
      } catch {
        setLocalInterjections((prev) =>
          prev.map((row) => (row.localId === localId ? { ...row, state: "error" } : row)),
        );
      }
    },
    [actions],
  );

  const retryInterjection = useCallback(
    (localId: string) => {
      const row = localInterjections.find((candidate) => candidate.localId === localId);
      if (row) {
        void submitInterjection(row.text, localId);
      }
    },
    [localInterjections, submitInterjection],
  );

  const dismissInterjection = useCallback((localId: string) => {
    setLocalInterjections((prev) => prev.filter((row) => row.localId !== localId));
  }, []);

  const confirmAndClose = useCallback(async () => {
    const confirmed = await confirmDialog({
      title: t("rooms.closeConfirm.title"),
      message: t("rooms.closeConfirm.message"),
      confirmLabel: t("rooms.actions.close"),
      destructive: true,
    });
    if (confirmed) {
      await actions.closeRoom();
    }
  }, [actions, t]);

  const confirmAndReopen = useCallback(async () => {
    const confirmed = await confirmDialog({
      title: t("rooms.reopenConfirm.title"),
      message: t("rooms.reopenConfirm.message"),
      confirmLabel: t("rooms.actions.reopen"),
    });
    if (confirmed) {
      await actions.reopenRoom();
    }
  }, [actions, t]);

  const headerActions = useMemo(() => {
    if (!snapshot) {
      return null;
    }
    const room = snapshot.room;
    const filesBadge = filesQuery.data?.length ?? 0;
    return (
      <View style={styles.headerActions}>
        <PressHighlight
          style={styles.iconAction}
          onPress={openFilesDrawer}
          accessibilityLabel={t("rooms.files.title")}
          testID="room-files-button"
        >
          <Paperclip size={16} color={styles.iconActionColor.color} />
          {filesBadge > 0 ? (
            <View style={styles.filesBadge}>
              <Text style={styles.filesBadgeText}>{filesBadge}</Text>
            </View>
          ) : null}
        </PressHighlight>
        {renderRoomStatusActions(room, {
          actions,
          confirmAndClose,
          confirmAndReopen,
          t,
        })}
      </View>
    );
  }, [
    actions,
    confirmAndClose,
    confirmAndReopen,
    filesQuery.data?.length,
    openFilesDrawer,
    snapshot,
    t,
  ]);

  if (roomQuery.isPending && !snapshot) {
    return <RoomPanelLoading label={t("rooms.panel.loading")} />;
  }
  if (roomQuery.error && !snapshot) {
    return (
      <RoomPanelError
        error={roomQuery.error instanceof Error ? roomQuery.error.message : String(roomQuery.error)}
        onRetry={handleRetry}
      />
    );
  }
  if (!snapshot) {
    if (roomQuery.isSuccess && roomQuery.data.room === null) {
      return <RoomPanelEmpty />;
    }
    return <RoomPanelLoading label={t("rooms.panel.loading")} />;
  }

  const room = snapshot.room;
  const turnStream = room.turn.memberId ? streams[room.turn.memberId] : undefined;
  const streamHasText = Boolean(turnStream && turnStream.text.length > 0);
  const streamDone = Boolean(turnStream?.done);
  // A confirmed local row disappears the moment its transcript entry lands.
  const deliveredInterjectionIds = new Set<string>();
  for (const entry of room.transcript) {
    if (entry.kind === "interjection" && entry.interjectionId) {
      deliveredInterjectionIds.add(entry.interjectionId);
    }
  }
  const visibleInterjections = localInterjections.filter(
    (row) => !(row.interjectionId && deliveredInterjectionIds.has(row.interjectionId)),
  );

  return (
    <View style={styles.container} testID="room-panel-content">
      <RoomHeader room={room} actions={headerActions} />
      <RoomSeatline room={room} streamHasText={streamHasText} streamDone={streamDone} />
      <RoomSeats
        room={room}
        serverId={serverId}
        onOpenAgent={handleOpenAgent}
        onAddMember={openMemberAddSheet}
      />
      <View style={styles.noticeRegion}>
        <RoomReconnectAlert connected={isConnected} />
        <RoomFailureCard room={room} />
      </View>
      <View style={styles.feed}>
        <RoomTranscriptFeed
          room={room}
          serverId={serverId}
          truncated={snapshot.truncated}
          active={isPanelActive}
          pendingInterjections={visibleInterjections}
          files={filesQuery.data}
          onOpenFile={onOpenFile}
          onRetryInterjection={retryInterjection}
          onDismissInterjection={dismissInterjection}
        />
      </View>
      <RoomPermissionCard serverId={serverId} room={room} client={client} />
      <RoomCheckpointCard room={room} />
      <RoomClosingCard
        room={room}
        onContinue={focusComposer}
        onClose={confirmAndClose}
        closePending={actions.pendingAction === "close"}
      />
      <RoomInterruptedCard
        room={room}
        onResume={actions.resumeRoom}
        onClose={confirmAndClose}
        resumePending={actions.pendingAction === "resume"}
        closePending={actions.pendingAction === "close"}
      />
      {actions.actionError ? (
        <Alert
          variant="error"
          title={t("rooms.panel.actionFailed", { error: actions.actionError })}
          testID="room-action-error"
        >
          <Button variant="outline" size="sm" onPress={actions.dismissActionError}>
            {t("common.actions.dismiss")}
          </Button>
        </Alert>
      ) : null}
      <KeyboardAvoidingView style={styles.composer} behavior="padding">
        <RoomInterjectionComposer
          ref={composerRef}
          room={room}
          onSubmit={submitInterjection}
          submitting={actions.pendingAction === "interject"}
        />
      </KeyboardAvoidingView>
      {filesDrawerOpen ? (
        <RoomFilesDrawer
          room={room}
          files={filesQuery.data ?? []}
          onClose={closeFilesDrawer}
          onOpenFile={onOpenFile}
        />
      ) : null}
      {memberAddSheet ? (
        <RoomMemberAddSheet
          key={`${roomId}-${memberAddSheet.key}`}
          serverId={serverId}
          roomId={roomId}
          onClose={closeMemberAddSheet}
        />
      ) : null}
    </View>
  );
}

interface RoomInterjectionLike {
  id: string;
  createdAt: string;
}

/** Header actions per room status, unchanged from the pre-refactor behavior. */
function renderRoomStatusActions(
  room: NonNullable<ReturnType<typeof useRoomSnapshot>>["room"],
  input: {
    actions: ReturnType<typeof useRoomActions>;
    confirmAndClose: () => Promise<void>;
    confirmAndReopen: () => Promise<void>;
    t: (key: string) => string;
  },
): ReactNode {
  const { actions, confirmAndClose, confirmAndReopen, t } = input;
  switch (room.status) {
    case "forming":
      return (
        <>
          <Button
            variant="default"
            size="md"
            onPress={actions.startRoom}
            disabled={actions.pendingAction !== null}
            loading={actions.pendingAction === "start"}
            testID="room-start"
          >
            {t("rooms.actions.start")}
          </Button>
          <Button
            variant="outline"
            size="md"
            onPress={confirmAndClose}
            disabled={actions.pendingAction !== null}
            testID="room-close-header"
          >
            {t("rooms.actions.close")}
          </Button>
        </>
      );
    case "opening":
    case "discussing":
      return (
        <>
          <Button
            variant="default"
            size="md"
            onPress={actions.pauseRoom}
            disabled={actions.pendingAction !== null}
            loading={actions.pendingAction === "pause"}
            testID="room-pause"
          >
            {t("rooms.actions.pause")}
          </Button>
          <Button
            variant="outline"
            size="md"
            onPress={confirmAndClose}
            disabled={actions.pendingAction !== null}
            testID="room-close-header"
          >
            {t("rooms.actions.close")}
          </Button>
        </>
      );
    case "closed":
      return (
        <Button
          variant="outline"
          size="md"
          onPress={confirmAndReopen}
          disabled={actions.pendingAction !== null}
          loading={actions.pendingAction === "reopen"}
          testID="room-reopen"
        >
          {t("rooms.actions.reopen")}
        </Button>
      );
    default:
      // closing and interrupted carry their actions in dedicated cards.
      return null;
  }
}

function RoomPanelLoading({ label }: { label: string }) {
  return (
    <View style={styles.center} testID="room-panel-loading">
      <LoadingSpinner size="large" color={styles.loadingText.color} />
      <Text style={styles.loadingText}>{label}</Text>
    </View>
  );
}

function RoomPanelError({ error, onRetry }: { error: string; onRetry: () => void }) {
  const { t } = useTranslation();
  return (
    <View style={styles.center} testID="room-panel-error">
      <Alert variant="error" title={t("rooms.panel.errorTitle")} description={error}>
        <Button variant="outline" size="sm" onPress={onRetry} testID="room-panel-retry">
          {t("rooms.panel.retry")}
        </Button>
      </Alert>
    </View>
  );
}

function RoomPanelEmpty() {
  const { t } = useTranslation();
  return (
    <View style={styles.center} testID="room-panel-empty">
      <Text style={styles.loadingText}>{t("rooms.panel.notFound")}</Text>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    gap: theme.spacing[3],
    padding: theme.spacing[3],
  },
  headerActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  iconAction: {
    width: 44,
    height: 44,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.borderRadius.md,
  },
  iconActionColor: {
    color: theme.colors.foregroundMuted,
  },
  filesBadge: {
    position: "absolute",
    top: 4,
    right: 2,
    minWidth: 16,
    height: 16,
    paddingHorizontal: 4,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.surface3,
    borderWidth: 1,
    borderColor: theme.colors.border,
    alignItems: "center",
    justifyContent: "center",
  },
  filesBadgeText: {
    fontSize: 10,
    lineHeight: 12,
    color: theme.colors.foreground,
  },
  noticeRegion: {
    gap: theme.spacing[2],
  },
  feed: {
    flex: 1,
    minHeight: 120,
  },
  composer: {
    paddingBottom: theme.spacing[2],
  },
  center: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing[3],
    padding: theme.spacing[4],
  },
  loadingText: {
    fontSize: theme.fontSize.base,
    color: theme.colors.foregroundMuted,
  },
}));
