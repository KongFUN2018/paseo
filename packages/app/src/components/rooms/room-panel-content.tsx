import { useCallback, useMemo, useRef } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { KeyboardAvoidingView } from "react-native-keyboard-controller";
import { StyleSheet } from "react-native-unistyles";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { useRetainedPanelActive } from "@/components/retained-panel";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { RoomHeader, RoomStatusBar } from "@/components/rooms/room-header";
import { RoomSeats } from "@/components/rooms/room-seats";
import {
  RoomFailureCard,
  RoomPermissionCard,
  RoomReconnectAlert,
} from "@/components/rooms/room-notice-region";
import { RoomTranscriptFeed } from "@/components/rooms/room-transcript-feed";
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
import { useRoomQuery } from "@/rooms/rooms-query";
import { useRoomSnapshot } from "@/rooms/rooms-store";
import { confirmDialog } from "@/utils/confirm-dialog";

export interface RoomPanelContentProps {
  serverId: string;
  roomId: string;
  onOpenAgent: (agentId: string) => void;
}

export function RoomPanelContent({ serverId, roomId, onOpenAgent }: RoomPanelContentProps) {
  const { t } = useTranslation();
  const isPanelActive = useRetainedPanelActive();
  const client = useHostRuntimeClient(serverId);
  const isConnected = useHostRuntimeIsConnected(serverId);
  const roomQuery = useRoomQuery(serverId, roomId, Boolean(client));
  const snapshot = useRoomSnapshot(serverId, roomId);
  const actions = useRoomActions(serverId, roomId);
  const composerRef = useRef<RoomInterjectionComposerHandle>(null);

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
    switch (room.status) {
      case "forming":
        return (
          <View style={styles.headerActions}>
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
          </View>
        );
      case "opening":
      case "discussing":
        return (
          <View style={styles.headerActions}>
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
          </View>
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
  }, [actions, confirmAndClose, confirmAndReopen, snapshot, t]);

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

  return (
    <View style={styles.container} testID="room-panel-content">
      <RoomHeader room={room} actions={headerActions} />
      <RoomStatusBar room={room} />
      <RoomSeats room={room} onOpenAgent={handleOpenAgent} />
      <View style={styles.noticeRegion}>
        <RoomReconnectAlert connected={isConnected} />
        <RoomFailureCard room={room} />
      </View>
      <View style={styles.feed}>
        <RoomTranscriptFeed room={room} truncated={snapshot.truncated} active={isPanelActive} />
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
          onSubmit={actions.interject}
          submitting={actions.pendingAction === "interject"}
        />
      </KeyboardAvoidingView>
    </View>
  );
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
    gap: theme.spacing[2],
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
