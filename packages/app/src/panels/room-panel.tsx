import invariant from "tiny-invariant";
import { useCallback, Component, type ReactNode } from "react";
import { Text, View } from "react-native";
import { MessageSquarePlus } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import { usePaneContext } from "@/panels/pane-context";
import { definePanel } from "@/panels/panel-registry";
import { Button } from "@/components/ui/button";
import { RoomPanelContent } from "@/components/rooms/room-panel-content";
import { roomStatusTranslationKey } from "@/components/rooms/room-header";
import { useRoomSnapshot } from "@/rooms/rooms-store";
import { i18n } from "@/i18n/i18next";

function RoomPanel() {
  const { serverId, target, openTab, openPreferredTarget } = usePaneContext();
  invariant(target.kind === "room", "RoomPanel requires a room target");
  const handleOpenAgent = useCallback(
    (agentId: string) => {
      openTab({ kind: "agent", agentId });
    },
    [openTab],
  );
  const handleOpenFile = useCallback(
    (path: string) => {
      openPreferredTarget({ kind: "file", path }, "explorerFiles");
    },
    [openPreferredTarget],
  );

  return (
    <RoomPanelErrorBoundary>
      <RoomPanelContent
        serverId={serverId}
        roomId={target.roomId}
        onOpenAgent={handleOpenAgent}
        onOpenFile={handleOpenFile}
      />
    </RoomPanelErrorBoundary>
  );
}

interface RoomPanelErrorBoundaryState {
  /** Bumped to remount the panel content after a caught error (#P0-1). */
  generation: number;
  error: string | null;
}

/**
 * Keeps a room panel render error inside the panel (#P0-1). Without a local
 * boundary the error unmounts the whole app to the root fallback — observed in
 * the 2026-10-25 acceptance as a blank room panel with no interrupted card and
 * no resume action. A caught panel renders an in-place error card with a retry
 * that remounts the content against the (unchanged) rooms store snapshot.
 */
export class RoomPanelErrorBoundary extends Component<
  { children: ReactNode },
  RoomPanelErrorBoundaryState
> {
  state: RoomPanelErrorBoundaryState = { generation: 0, error: null };

  static getDerivedStateFromError(error: unknown): { error: string } {
    return { error: error instanceof Error ? error.message : String(error) };
  }

  componentDidCatch(error: unknown): void {
    console.error("[RoomPanelErrorBoundary] Room panel render error", {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  private readonly retry = () => {
    this.setState((state) => ({ generation: state.generation + 1, error: null }));
  };

  render() {
    if (this.state.error !== null) {
      const t = i18n.t.bind(i18n);
      return (
        <View style={styles.fallback} testID="room-panel-error-boundary">
          <Text style={styles.fallbackTitle}>{t("rooms.panel.errorTitle")}</Text>
          <Text style={styles.fallbackError}>{this.state.error}</Text>
          <Button variant="outline" size="sm" onPress={this.retry} testID="room-panel-retry">
            {t("rooms.panel.retry")}
          </Button>
        </View>
      );
    }
    return (
      <View key={this.state.generation} style={styles.host}>
        {this.props.children}
      </View>
    );
  }
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

const styles = StyleSheet.create((theme) => ({
  host: {
    flex: 1,
  },
  fallback: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing[3],
    padding: theme.spacing[4],
  },
  fallbackTitle: {
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foreground,
  },
  fallbackError: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
    textAlign: "center",
  },
}));
