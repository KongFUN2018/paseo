import { useCallback, useMemo } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { useStoreWithEqualityFn } from "zustand/traditional";
import { shallow } from "zustand/shallow";
import { StyleSheet } from "react-native-unistyles";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { AgentPermissionResponse } from "@getpaseo/protocol/agent-types";
import type { RoomRecord } from "@getpaseo/protocol/room/types";
import { useMutation } from "@tanstack/react-query";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { useSessionStore } from "@/stores/session-store";
import { requireDaemonClient } from "@/rooms/rooms-query";
import type { PendingPermission } from "@/types/shared";
import { memberLabel } from "@/components/rooms/room-header";

/**
 * Member permission requests surfaced inside the room. Responses route through
 * the existing agent permission channel; the room owns no permission protocol.
 */
export function RoomPermissionCard({
  serverId,
  room,
  client,
}: {
  serverId: string;
  room: RoomRecord;
  client: DaemonClient | null;
}) {
  const { t } = useTranslation();
  const memberAgentIds = useMemo(
    () => new Set(room.members.map((member) => member.agentId).filter(Boolean)),
    [room.members],
  );

  const permissions = useStoreWithEqualityFn(
    useSessionStore,
    (state) => {
      const all = state.sessions[serverId]?.pendingPermissions;
      if (!all) return [];
      const filtered: PendingPermission[] = [];
      for (const permission of all.values()) {
        if (memberAgentIds.has(permission.agentId)) {
          filtered.push(permission);
        }
      }
      return filtered;
    },
    shallow,
  );

  const respondMutation = useMutation({
    mutationFn: async (input: {
      permission: PendingPermission;
      response: AgentPermissionResponse;
    }) => {
      const daemon = client ?? requireDaemonClient(serverId);
      await daemon.respondToPermission(
        input.permission.agentId,
        input.permission.request.id,
        input.response,
      );
    },
  });

  if (permissions.length === 0) {
    return null;
  }
  const permission = permissions[0];
  const ownerLabel = room.members.find((member) => member.agentId === permission.agentId);

  return (
    <View style={styles.card} testID="room-permission-card">
      <Text style={styles.cardTitle}>
        {t("rooms.permission.title", {
          name: ownerLabel ? memberLabel(ownerLabel.id) : "Member",
        })}
      </Text>
      <Text style={styles.request} numberOfLines={3}>
        {permission.request.title ?? permission.request.name}
      </Text>
      <PermissionActions
        permission={permission}
        onRespond={respondMutation.mutate}
        disabled={respondMutation.isPending}
      />
      {respondMutation.error ? (
        <Text style={styles.error}>
          {respondMutation.error instanceof Error
            ? respondMutation.error.message
            : String(respondMutation.error)}
        </Text>
      ) : null}
    </View>
  );
}

function PermissionActions({
  permission,
  onRespond,
  disabled,
}: {
  permission: PendingPermission;
  onRespond: (input: { permission: PendingPermission; response: AgentPermissionResponse }) => void;
  disabled: boolean;
}) {
  const { t } = useTranslation();
  const handleDeny = useCallback(() => {
    onRespond({
      permission,
      response: { behavior: "deny", message: "Denied by user" },
    });
  }, [onRespond, permission]);
  const handleAllow = useCallback(() => {
    onRespond({ permission, response: { behavior: "allow" } });
  }, [onRespond, permission]);
  return (
    <View style={styles.actions}>
      <Button
        variant="outline"
        size="sm"
        onPress={handleDeny}
        disabled={disabled}
        testID="room-permission-deny"
      >
        {t("rooms.permission.deny")}
      </Button>
      <Button
        variant="default"
        size="sm"
        onPress={handleAllow}
        disabled={disabled}
        testID="room-permission-allow"
      >
        {t("rooms.permission.allow")}
      </Button>
    </View>
  );
}

/** Failed members stay visible with their reason; the room continues with the rest. */
export function RoomFailureCard({ room }: { room: RoomRecord }) {
  const { t } = useTranslation();
  const failedMembers = room.members.filter((member) => member.status === "failed");
  if (failedMembers.length === 0) {
    return null;
  }
  return (
    <View testID="room-failure-card">
      {failedMembers.map((member) => (
        <Text key={member.id} style={styles.failureText}>
          {t("rooms.failure.memberFailed", { name: memberLabel(member.id) })}
        </Text>
      ))}
    </View>
  );
}

export function RoomReconnectAlert({ connected }: { connected: boolean }) {
  const { t } = useTranslation();
  if (connected) {
    return null;
  }
  return (
    <Alert variant="warning" title={t("rooms.reconnect.title")} testID="room-reconnect-alert">
      <Text>{t("rooms.reconnect.body")}</Text>
    </Alert>
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
  request: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  actions: {
    flexDirection: "row",
    gap: theme.spacing[2],
  },
  error: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.statusDanger,
  },
  failureText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.statusDanger,
  },
}));
