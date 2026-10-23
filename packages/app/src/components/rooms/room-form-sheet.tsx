import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Text, View } from "react-native";
import { ChevronDown, ChevronRight, X } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { useMutation } from "@tanstack/react-query";
import type { AgentMode, AgentProvider } from "@getpaseo/protocol/agent-types";
import { StyleSheet } from "react-native-unistyles";
import { AdaptiveModalSheet, type SheetHeader } from "@/components/adaptive-modal-sheet";
import { Button } from "@/components/ui/button";
import { CombinedModelSelector } from "@/components/combined-model-selector";
import type { FieldControlSize } from "@/components/ui/control-geometry";
import { Field, FormTextInput } from "@/components/ui/form-field";
import { PressHighlight } from "@/components/ui/press-highlight";
import type { EditingTextInputHandle } from "@/components/ui/text-input";
import {
  SelectField,
  type SelectFieldDisplay,
  type SelectFieldOption,
} from "@/components/ui/select-field";
import { useIsCompactFormFactor } from "@/constants/layout";
import { isNative } from "@/constants/platform";
import {
  buildSelectableProviderSelectorProviders,
  type ProviderSelectorProvider,
} from "@/provider-selection/provider-selection";
import { requireDaemonClient } from "@/rooms/rooms-query";
import { useRoomFormModel } from "@/rooms/use-room-form-model";
import { useRoomFormProviderSnapshot } from "@/rooms/use-room-form-provider-snapshot";
import type {
  RoomArtifactPathError,
  RoomFormLimitsDraft,
  RoomFormModel,
  RoomFormState,
  RoomMemberRowValidation,
} from "@/rooms/room-form-model";
import { toErrorMessage } from "@/utils/error-messages";

export interface RoomFormSheetProps {
  visible: boolean;
  serverId: string | null;
  workspaceId: string | null;
  onCreated: (roomId: string) => void;
  onClose: () => void;
}

export function RoomFormSheet({
  visible,
  serverId,
  workspaceId,
  onCreated,
  onClose,
}: RoomFormSheetProps) {
  const { t } = useTranslation();
  const isCompact = useIsCompactFormFactor();
  const controlSize: FieldControlSize = isCompact ? "md" : "sm";
  const { model, state } = useRoomFormModel();
  const providerSnapshot = useRoomFormProviderSnapshot(model, serverId ?? "");
  const [limitsExpanded, setLimitsExpanded] = useState(false);

  const createMutation = useMutation({
    mutationFn: async () => {
      if (!serverId || !workspaceId) {
        throw new Error(t("common.errors.daemonClientUnavailable"));
      }
      const input = model.toCreateInput();
      if (!input) {
        throw new Error(t("rooms.form.submitIncomplete"));
      }
      const client = requireDaemonClient(serverId);
      const payload = await client.roomCreate({ ...input, workspaceId });
      if (payload.error) {
        throw new Error(payload.error);
      }
      return payload;
    },
    onSuccess: (payload) => {
      if (payload.roomId) {
        onCreated(payload.roomId);
      }
    },
    onError: (error: unknown) => {
      model.setSubmitError(toErrorMessage(error));
    },
  });

  const header = useMemo<SheetHeader>(() => ({ title: t("rooms.form.title") }), [t]);
  const handleSubmitPress = useCallback(() => {
    createMutation.mutate();
  }, [createMutation]);
  const submitLabel = createMutation.isPending ? t("rooms.form.creating") : t("rooms.form.create");
  const footer = useMemo(
    () => (
      <View style={styles.footer}>
        <Button
          style={styles.footerButton}
          variant="secondary"
          onPress={onClose}
          disabled={createMutation.isPending}
        >
          {t("common.actions.cancel")}
        </Button>
        <Button
          style={styles.footerButton}
          variant="default"
          onPress={handleSubmitPress}
          disabled={!state.canSubmit || createMutation.isPending}
          loading={createMutation.isPending}
          testID="room-form-submit"
        >
          {submitLabel}
        </Button>
      </View>
    ),
    [createMutation.isPending, handleSubmitPress, onClose, state.canSubmit, submitLabel, t],
  );

  if (!visible) {
    return null;
  }

  return (
    <AdaptiveModalSheet
      header={header}
      visible={visible}
      onClose={onClose}
      footer={footer}
      testID="room-form-sheet"
    >
      <RoomBasicsFields model={model} state={state} size={controlSize} />
      <RoomMemberList
        model={model}
        state={state}
        providerSnapshot={providerSnapshot}
        size={controlSize}
      />
      <RoomModeratorConfig
        model={model}
        state={state}
        providerSnapshot={providerSnapshot}
        size={controlSize}
      />
      <RoomArtifactPathField model={model} state={state} size={controlSize} />
      <RoomAdvancedLimits
        model={model}
        state={state}
        expanded={limitsExpanded}
        onToggleExpanded={setLimitsExpanded}
        size={controlSize}
      />
      {state.submitError ? <Text style={styles.submitError}>{state.submitError}</Text> : null}
    </AdaptiveModalSheet>
  );
}

function RoomBasicsFields({
  model,
  state,
  size,
}: {
  model: RoomFormModel;
  state: RoomFormState;
  size: FieldControlSize;
}) {
  const { t } = useTranslation();
  return (
    <>
      <Field
        label={t("rooms.form.name")}
        error={state.validation.nameMissing ? t("rooms.form.errors.nameRequired") : undefined}
      >
        <FormTextInput
          initialValue={state.name}
          onChangeText={model.setName}
          placeholder={t("rooms.form.namePlaceholder")}
          size={size}
          testID="room-form-name"
        />
      </Field>
      <Field
        label={t("rooms.form.topic")}
        error={state.validation.topicMissing ? t("rooms.form.errors.topicRequired") : undefined}
      >
        <FormTextInput
          initialValue={state.topic}
          onChangeText={model.setTopic}
          placeholder={t("rooms.form.topicPlaceholder")}
          size={size}
          multiline
          testID="room-form-topic"
        />
      </Field>
    </>
  );
}

function RoomMemberList({
  model,
  state,
  providerSnapshot,
  size,
}: {
  model: RoomFormModel;
  state: RoomFormState;
  providerSnapshot: ReturnType<typeof useRoomFormProviderSnapshot>;
  size: FieldControlSize;
}) {
  const { t } = useTranslation();
  const providers = useMemo(
    () => buildSelectableProviderSelectorProviders(providerSnapshot.entries),
    [providerSnapshot.entries],
  );
  const isLoading = state.providerSnapshotStatus !== "loaded";

  return (
    <View>
      <Text style={styles.sectionLabel}>{t("rooms.form.members")}</Text>
      {state.members.map((member, index) => (
        <RoomMemberConfigRow
          key={member.rowId}
          index={index}
          member={member}
          validation={state.validation.members[index]}
          providers={providers}
          isLoading={isLoading}
          canRemove={state.members.length > 2}
          model={model}
          size={size}
        />
      ))}
      {state.members.length < 4 ? (
        <Button
          variant="ghost"
          size="sm"
          onPress={model.addMember}
          testID="room-form-add-member"
          accessibilityLabel={t("rooms.form.addMember")}
        >
          {t("rooms.form.addMember")}
        </Button>
      ) : null}
    </View>
  );
}

function RoomMemberConfigRow({
  index,
  member,
  validation,
  providers,
  isLoading,
  canRemove,
  model,
  size,
}: {
  index: number;
  member: RoomFormState["members"][number];
  validation: RoomMemberRowValidation;
  providers: ProviderSelectorProvider[];
  isLoading: boolean;
  canRemove: boolean;
  model: RoomFormModel;
  size: FieldControlSize;
}) {
  const { t } = useTranslation();
  const isCompact = useIsCompactFormFactor();
  const [isHovered, setIsHovered] = useState(false);
  const showRemove = canRemove && (isHovered || isNative || isCompact);
  const handlePointerEnter = useCallback(() => setIsHovered(true), []);
  const handlePointerLeave = useCallback(() => setIsHovered(false), []);
  const handleRemove = useCallback(() => {
    model.removeMember(member.rowId);
  }, [member.rowId, model]);
  const handleSelect = useCallback(
    (provider: AgentProvider, modelId: string) => {
      model.setMemberSelection(member.rowId, provider, modelId);
    },
    [member.rowId, model],
  );
  const handlePersonaChange = useCallback(
    (value: string) => {
      model.setMemberPersona(member.rowId, value);
    },
    [member.rowId, model],
  );
  const removeIconColor = styles.memberRowTitle.color;

  return (
    <View
      style={styles.memberRow}
      onPointerEnter={handlePointerEnter}
      onPointerLeave={handlePointerLeave}
    >
      <View style={styles.memberRowHeader}>
        <Text style={styles.memberRowTitle}>
          {t("rooms.form.memberLabel", { index: index + 1 })}
        </Text>
        {showRemove ? (
          <PressHighlight
            onPress={handleRemove}
            accessibilityLabel={t("rooms.form.removeMember")}
            hitSlop={8}
            testID={`room-form-remove-member-${index}`}
          >
            <X size={14} color={removeIconColor} />
          </PressHighlight>
        ) : null}
      </View>
      <CombinedModelSelector
        providers={providers}
        selectedProvider={member.provider ?? ""}
        selectedModel={member.modelId}
        onSelect={handleSelect}
        isLoading={isLoading}
        triggerFill
      />
      {validation.duplicateCombination ? (
        <Text style={styles.rowError}>{t("rooms.form.errors.memberDuplicate")}</Text>
      ) : null}
      <FormTextInput
        initialValue={member.persona}
        onChangeText={handlePersonaChange}
        placeholder={t("rooms.form.personaPlaceholder")}
        size={size}
        testID={`room-form-member-persona-${index}`}
      />
    </View>
  );
}

function RoomModeratorConfig({
  model,
  state,
  providerSnapshot,
  size,
}: {
  model: RoomFormModel;
  state: RoomFormState;
  providerSnapshot: ReturnType<typeof useRoomFormProviderSnapshot>;
  size: FieldControlSize;
}) {
  const { t } = useTranslation();
  const providers = useMemo(
    () => buildSelectableProviderSelectorProviders(providerSnapshot.entries),
    [providerSnapshot.entries],
  );
  const isLoading = state.providerSnapshotStatus !== "loaded";
  const handleSelect = useCallback(
    (provider: AgentProvider, modelId: string) => {
      model.setModeratorSelection(provider, modelId);
    },
    [model],
  );
  const handleModeChange = useCallback(
    (modeId: string | null) => {
      model.setModeratorMode(modeId);
    },
    [model],
  );

  const modeOptions = useMemo<SelectFieldOption<string>[]>(() => {
    const entry = providerSnapshot.entries?.find(
      (candidate) => candidate.provider === state.moderator.provider,
    );
    const modes: AgentMode[] = entry?.modes ?? [];
    return modes.map((mode) => ({
      id: mode.id,
      value: mode.id,
      label: mode.label ?? mode.id,
      testID: `room-form-moderator-mode-${mode.id}`,
    }));
  }, [providerSnapshot.entries, state.moderator.provider]);

  const selectedModeDisplay = useMemo<SelectFieldDisplay>(() => {
    const mode = modeOptions.find((option) => option.value === state.moderator.modeId);
    return { label: mode?.label ?? t("rooms.form.defaultMode") };
  }, [modeOptions, state.moderator.modeId, t]);

  return (
    <View style={styles.moderatorSection}>
      <Text style={styles.sectionLabel}>{t("rooms.form.moderator")}</Text>
      <CombinedModelSelector
        providers={providers}
        selectedProvider={state.moderator.provider ?? ""}
        selectedModel={state.moderator.modelId}
        onSelect={handleSelect}
        isLoading={isLoading}
        triggerFill
      />
      <SelectField
        label={t("rooms.form.mode")}
        value={state.moderator.modeId}
        selectedDisplay={selectedModeDisplay}
        options={modeOptions}
        onChange={handleModeChange}
        placeholder={t("rooms.form.defaultMode")}
        emptyText={t("rooms.form.noModes")}
        disabled={modeOptions.length === 0}
        title={t("rooms.form.mode")}
        size={size}
        triggerTestID="room-form-moderator-mode"
      />
    </View>
  );
}

function artifactPathErrorMessage(
  code: RoomArtifactPathError | null,
  t: (key: string) => string,
): string | undefined {
  if (code === "required") {
    return t("rooms.form.errors.artifactPathRequired");
  }
  if (code === "notRelative") {
    return t("rooms.form.errors.artifactPathNotRelative");
  }
  return undefined;
}

function RoomArtifactPathField({
  model,
  state,
  size,
}: {
  model: RoomFormModel;
  state: RoomFormState;
  size: FieldControlSize;
}) {
  const { t } = useTranslation();
  const inputRef = useRef<EditingTextInputHandle>(null);
  // The name-derived default is programmatic; echo it into the editor unless
  // the change originated from this input's own change events.
  const lastReportedRef = useRef<string | null>(null);
  useEffect(() => {
    if (lastReportedRef.current === state.artifactPath) {
      return;
    }
    inputRef.current?.replaceText(state.artifactPath);
  }, [state.artifactPath]);
  const handleChange = useCallback(
    (value: string) => {
      lastReportedRef.current = value;
      model.setArtifactPath(value);
    },
    [model],
  );

  const error = artifactPathErrorMessage(state.validation.artifactPath, t);
  return (
    <Field label={t("rooms.form.artifactPath")} error={error}>
      <FormTextInput
        ref={inputRef}
        initialValue={state.artifactPath}
        onChangeText={handleChange}
        placeholder=".paseo/rooms/…/summary.md"
        size={size}
        testID="room-form-artifact-path"
      />
    </Field>
  );
}

interface RoomLimitFieldProps {
  model: RoomFormModel;
  value: string;
  field: keyof RoomFormLimitsDraft;
  label: string;
  keyboardType: "number-pad" | "decimal-pad";
  error?: string;
  size: FieldControlSize;
  testID: string;
}

function RoomLimitField({
  model,
  value,
  field,
  label,
  keyboardType,
  error,
  size,
  testID,
}: RoomLimitFieldProps) {
  const handleChange = useCallback(
    (text: string) => {
      model.setLimitField(field, text);
    },
    [field, model],
  );
  return (
    <Field label={label} error={error}>
      <FormTextInput
        initialValue={value}
        onChangeText={handleChange}
        size={size}
        keyboardType={keyboardType}
        testID={testID}
      />
    </Field>
  );
}

function RoomAdvancedLimits({
  model,
  state,
  expanded,
  onToggleExpanded,
  size,
}: {
  model: RoomFormModel;
  state: RoomFormState;
  expanded: boolean;
  onToggleExpanded: (expanded: boolean) => void;
  size: FieldControlSize;
}) {
  const { t } = useTranslation();
  const Chevron = expanded ? ChevronDown : ChevronRight;
  const handleToggle = useCallback(() => {
    onToggleExpanded(!expanded);
  }, [expanded, onToggleExpanded]);
  const limitsError = state.validation.limitsInvalid
    ? t("rooms.form.errors.limitsInvalid")
    : undefined;
  return (
    <View style={styles.limitsSection}>
      <PressHighlight
        style={styles.limitsToggle}
        onPress={handleToggle}
        accessibilityLabel={t("rooms.form.limits")}
        testID="room-form-limits-toggle"
      >
        <Chevron size={14} color={styles.limitsLabel.color} />
        <Text style={styles.limitsLabel}>{t("rooms.form.limits")}</Text>
      </PressHighlight>
      {expanded ? (
        <View style={styles.limitsFields}>
          <RoomLimitField
            model={model}
            value={state.limits.maxRounds}
            field="maxRounds"
            label={t("rooms.form.maxRounds")}
            keyboardType="number-pad"
            size={size}
            testID="room-form-max-rounds"
          />
          <RoomLimitField
            model={model}
            value={state.limits.maxTurns}
            field="maxTurns"
            label={t("rooms.form.maxTurns")}
            keyboardType="number-pad"
            size={size}
            testID="room-form-max-turns"
          />
          <RoomLimitField
            model={model}
            value={state.limits.turnTimeoutMinutes}
            field="turnTimeoutMinutes"
            label={t("rooms.form.turnTimeout")}
            keyboardType="decimal-pad"
            error={limitsError}
            size={size}
            testID="room-form-turn-timeout"
          />
          <RoomLimitField
            model={model}
            value={state.limits.deltaCharBudget}
            field="deltaCharBudget"
            label={t("rooms.form.deltaCharBudget")}
            keyboardType="number-pad"
            size={size}
            testID="room-form-delta-budget"
          />
        </View>
      ) : null}
    </View>
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
  sectionLabel: {
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foregroundMuted,
    marginTop: theme.spacing[4],
    marginBottom: theme.spacing[2],
  },
  memberRow: {
    gap: theme.spacing[2],
    marginBottom: theme.spacing[3],
  },
  memberRowHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    minHeight: 24,
  },
  memberRowTitle: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  rowError: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.statusDanger,
  },
  submitError: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.statusDanger,
    marginTop: theme.spacing[2],
  },
  moderatorSection: {
    gap: theme.spacing[2],
  },
  limitsSection: {
    marginTop: theme.spacing[2],
  },
  limitsToggle: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1.5],
    minHeight: 44,
  },
  limitsLabel: {
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foregroundMuted,
  },
  limitsFields: {
    gap: theme.spacing[2],
    paddingBottom: theme.spacing[2],
  },
}));
