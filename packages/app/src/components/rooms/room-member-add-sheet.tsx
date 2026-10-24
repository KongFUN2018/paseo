import { useCallback, useEffect, useMemo } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import type { AgentProvider } from "@getpaseo/protocol/agent-types";
import { AdaptiveModalSheet, type SheetHeader } from "@/components/adaptive-modal-sheet";
import { Button } from "@/components/ui/button";
import { CombinedModelSelector } from "@/components/combined-model-selector";
import type { FieldControlSize } from "@/components/ui/control-geometry";
import { Field, FormTextInput } from "@/components/ui/form-field";
import { DisplayNameInput } from "@/components/rooms/display-name-input";
import { RolePresetChips } from "@/components/rooms/role-preset-chips";
import { useIsCompactFormFactor } from "@/constants/layout";
import { buildSelectableProviderSelectorProviders } from "@/provider-selection/provider-selection";
import { useProvidersSnapshot } from "@/hooks/use-providers-snapshot";
import { requireDaemonClient } from "@/rooms/rooms-query";
import { applyRoomUpdate } from "@/rooms/rooms-store";
import { useRoomMemberAddFormModel } from "@/rooms/use-room-member-add-form-model";
import type {
  RoomMemberAddFormModel,
  RoomMemberAddFormState,
} from "@/rooms/room-member-add-form-model";
import { toErrorMessage } from "@/utils/error-messages";

export interface RoomMemberAddSheetProps {
  serverId: string;
  roomId: string;
  onClose: () => void;
}

/**
 * Mid-room member join sheet (design §4.5). The parent mounts it fresh per
 * open (key = roomId + open timestamp) and closes it when the join succeeds;
 * failures keep every input and stay retryable inside the sheet.
 */
export function RoomMemberAddSheet({ serverId, roomId, onClose }: RoomMemberAddSheetProps) {
  const { t } = useTranslation();
  const isCompact = useIsCompactFormFactor();
  const controlSize: FieldControlSize = isCompact ? "md" : "sm";
  const { model, state } = useRoomMemberAddFormModel();

  const header = useMemo<SheetHeader>(() => ({ title: t("rooms.memberAdd.title") }), [t]);

  const submit = useCallback(async () => {
    const input = model.toAddInput();
    if (!input || state.status === "submitting") {
      return;
    }
    model.setSubmitError(null);
    model.setSubmitStatus("submitting");
    try {
      const client = requireDaemonClient(serverId);
      // `room.member.add` is synchronous: the response resolves after the
      // provider probe and the roster write, so the snapshot it carries is
      // authoritative and closing here is safe (§7.2).
      const payload = await client.roomMemberAdd({ roomId, member: input });
      if (payload.error) {
        throw new Error(payload.error);
      }
      if (payload.room) {
        applyRoomUpdate(serverId, payload.room, false);
      }
      model.setSubmitStatus("done");
      onClose();
    } catch (error) {
      model.setSubmitStatus("error");
      model.setSubmitError(toErrorMessage(error));
    }
  }, [model, onClose, roomId, serverId, state.status]);

  const footer = useMemo(
    () => (
      <View style={styles.footer}>
        <Button
          style={styles.footerButton}
          variant="secondary"
          onPress={onClose}
          disabled={state.status === "submitting"}
        >
          {t("common.actions.cancel")}
        </Button>
        <Button
          style={styles.footerButton}
          variant="default"
          onPress={submit}
          disabled={!state.canSubmit || state.status === "submitting"}
          loading={state.status === "submitting"}
          testID="room-member-add-submit"
        >
          {state.status === "submitting" ? t("rooms.memberAdd.joining") : t("rooms.memberAdd.join")}
        </Button>
      </View>
    ),
    [onClose, state.canSubmit, state.status, submit, t],
  );

  return (
    <AdaptiveModalSheet
      header={header}
      visible
      onClose={onClose}
      footer={footer}
      testID="room-member-add-sheet"
    >
      <RolePresetSection model={model} state={state} />
      <DisplayNameField model={model} state={state} size={controlSize} />
      <Field label={t("rooms.memberAdd.persona")}>
        <FormTextInput
          initialValue={state.persona}
          onChangeText={model.setPersona}
          placeholder={t("rooms.memberAdd.personaPlaceholder")}
          size={controlSize}
          multiline
          testID="room-member-add-persona"
        />
      </Field>
      <ProviderModelField model={model} state={state} serverId={serverId} />
      {state.submitError ? (
        <Text style={styles.submitError} testID="room-member-add-error">
          {state.submitError}
        </Text>
      ) : null}
    </AdaptiveModalSheet>
  );
}

function RolePresetSection({
  model,
  state,
}: {
  model: RoomMemberAddFormModel;
  state: RoomMemberAddFormState;
}) {
  const { t } = useTranslation();
  const handleSelect = useCallback(
    (roleId: string | null) => {
      model.selectRolePreset(roleId);
    },
    [model],
  );
  return (
    <View style={styles.section}>
      <Text style={styles.sectionLabel}>{t("rooms.form.rolePreset")}</Text>
      <RolePresetChips
        selectedRoleId={state.roleId}
        onSelect={handleSelect}
        testIDPrefix="room-member-add-role"
      />
    </View>
  );
}

function DisplayNameField({
  model,
  state,
  size,
}: {
  model: RoomMemberAddFormModel;
  state: RoomMemberAddFormState;
  size: FieldControlSize;
}) {
  const { t } = useTranslation();
  return (
    <Field
      label={t("rooms.memberAdd.displayName")}
      error={
        state.validation.displayNameMissing
          ? t("rooms.memberAdd.errors.displayNameRequired")
          : undefined
      }
    >
      <DisplayNameInput
        value={state.displayName}
        onChangeText={model.setDisplayName}
        placeholder={t("rooms.memberAdd.displayNamePlaceholder")}
        size={size}
        testID="room-member-add-display-name"
      />
    </Field>
  );
}

function ProviderModelField({
  model,
  state,
  serverId,
}: {
  model: RoomMemberAddFormModel;
  state: RoomMemberAddFormState;
  serverId: string;
}) {
  const snapshot = useProvidersSnapshot(serverId, { cwd: null });
  useEffect(() => {
    if (!snapshot.entries) {
      model.setProviderSnapshotStatus("connecting");
      return;
    }
    model.applyProviderSnapshot(snapshot.entries);
  }, [model, snapshot.entries]);

  const providers = useMemo(
    () => buildSelectableProviderSelectorProviders(snapshot.entries),
    [snapshot.entries],
  );
  const handleSelect = useCallback(
    (provider: AgentProvider, modelId: string) => {
      model.setProviderSelection(provider, modelId);
    },
    [model],
  );
  return (
    <CombinedModelSelector
      providers={providers}
      selectedProvider={state.provider ?? ""}
      selectedModel={state.modelId}
      onSelect={handleSelect}
      isLoading={state.providerSnapshotStatus !== "loaded"}
      triggerFill
    />
  );
}

const styles = StyleSheet.create((theme) => ({
  footer: {
    flex: 1,
    flexDirection: "row",
    gap: theme.spacing[3],
  },
  footerButton: {
    flex: 1,
  },
  section: {
    gap: theme.spacing[2],
    marginBottom: theme.spacing[3],
  },
  sectionLabel: {
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foregroundMuted,
  },
  submitError: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.statusDanger,
    marginTop: theme.spacing[2],
  },
}));
