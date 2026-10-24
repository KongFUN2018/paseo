import type { AgentProvider, ProviderSnapshotEntry } from "@getpaseo/protocol/agent-types";
import { DEFAULT_ROOM_LIMITS, type RoomLimits } from "@getpaseo/protocol/room/types";
import { roomRolePresetLabel } from "@/rooms/role-presets";

export interface RoomCreateMemberInput {
  provider: AgentProvider;
  model?: string | null;
  modeId?: string | null;
  persona: string;
  // COMPAT(roomRefactor): optional wire fields, present only when set.
  displayName?: string;
  roleId?: string;
}

export interface RoomCreateModeratorInput {
  provider: AgentProvider;
  model?: string | null;
  modeId?: string | null;
}

export interface RoomCreateInput {
  workspaceId: string;
  name: string;
  topic: string;
  moderator: RoomCreateModeratorInput;
  members: RoomCreateMemberInput[];
  artifactPath: string;
  limits?: RoomLimits;
}

export interface RoomFormMemberDraft {
  rowId: string;
  provider: AgentProvider | null;
  modelId: string;
  persona: string;
  // Role preset selection (§5.5); null is the "custom" choice.
  roleId: string | null;
  displayName: string;
}

export interface RoomFormModeratorDraft {
  provider: AgentProvider | null;
  modelId: string;
  modeId: string | null;
}

export type RoomArtifactPathError = "required" | "notRelative";

export interface RoomMemberRowValidation {
  providerMissing: boolean;
  modelMissing: boolean;
  duplicateCombination: boolean;
}

export interface RoomFormValidation {
  nameMissing: boolean;
  topicMissing: boolean;
  members: RoomMemberRowValidation[];
  moderator: { providerMissing: boolean; modelMissing: boolean };
  artifactPath: RoomArtifactPathError | null;
  limitsInvalid: boolean;
}

export interface RoomFormLimitsDraft {
  maxRounds: string;
  maxTurns: string;
  turnTimeoutMinutes: string;
  deltaCharBudget: string;
}

export interface RoomFormState {
  name: string;
  topic: string;
  members: RoomFormMemberDraft[];
  moderator: RoomFormModeratorDraft;
  artifactPath: string;
  artifactPathTouched: boolean;
  limits: RoomFormLimitsDraft;
  limitsExpanded: boolean;
  providerSnapshotStatus: "connecting" | "loaded";
  providerEntries: ProviderSnapshotEntry[] | null;
  submitError: string | null;
  canSubmit: boolean;
  validation: RoomFormValidation;
}

export interface RoomFormModel {
  getState(): RoomFormState;
  subscribe(listener: () => void): () => void;
  close(): void;
  setProviderSnapshotStatus(status: "connecting" | "loaded"): void;
  applyProviderSnapshot(entries: ProviderSnapshotEntry[]): void;
  setName(value: string): void;
  setTopic(value: string): void;
  addMember(): void;
  removeMember(rowId: string): void;
  setMemberSelection(rowId: string, provider: AgentProvider, modelId: string): void;
  setMemberRolePreset(rowId: string, roleId: string | null): void;
  setMemberDisplayName(rowId: string, value: string): void;
  setMemberPersona(rowId: string, value: string): void;
  setModeratorSelection(provider: AgentProvider, modelId: string): void;
  setModeratorMode(modeId: string | null): void;
  setArtifactPath(value: string): void;
  setLimitField(field: keyof RoomFormLimitsDraft, value: string): void;
  setLimitsExpanded(expanded: boolean): void;
  setSubmitError(value: string | null): void;
  toCreateInput(): Omit<RoomCreateInput, "workspaceId"> | null;
}

const MIN_MEMBERS = 2;
const MAX_MEMBERS = 4;

function defaultLimitsDraft(): RoomFormLimitsDraft {
  return {
    maxRounds: String(DEFAULT_ROOM_LIMITS.maxRounds),
    maxTurns: String(DEFAULT_ROOM_LIMITS.maxTurns),
    turnTimeoutMinutes: String(DEFAULT_ROOM_LIMITS.turnTimeoutMs / 60_000),
    deltaCharBudget: String(DEFAULT_ROOM_LIMITS.deltaCharBudget),
  };
}

/** Derive `.paseo/rooms/<slug>/summary.md` from the room name. */
export function buildDefaultArtifactPath(name: string): string {
  const slug =
    name
      .trim()
      .toLowerCase()
      .replace(/[\s_]+/g, "-")
      .replace(/[^\p{L}\p{N}-]+/gu, "")
      .replace(/-{2,}/g, "-")
      .replace(/^-+|-+$/g, "") || "room";
  return `.paseo/rooms/${slug}/summary.md`;
}

/** Workspace-relative path check: reject absolute paths, drive letters, and `..` segments. */
export function validateRoomArtifactPath(value: string): RoomArtifactPathError | null {
  const path = value.trim();
  if (path.length === 0) {
    return "required";
  }
  if (path.startsWith("/") || path.startsWith("\\")) {
    return "notRelative";
  }
  if (/^[a-zA-Z]:/.test(path)) {
    return "notRelative";
  }
  const segments = path.split(/[\\/]/);
  if (segments.some((segment) => segment === "..")) {
    return "notRelative";
  }
  return null;
}

export function parseRoomLimits(draft: RoomFormLimitsDraft): RoomLimits | null {
  const maxRounds = Number.parseInt(draft.maxRounds, 10);
  const maxTurns = Number.parseInt(draft.maxTurns, 10);
  const deltaCharBudget = Number.parseInt(draft.deltaCharBudget, 10);
  const turnTimeoutMinutes = Number.parseFloat(draft.turnTimeoutMinutes);
  if (
    !Number.isFinite(maxRounds) ||
    maxRounds <= 0 ||
    !Number.isFinite(maxTurns) ||
    maxTurns <= 0 ||
    !Number.isFinite(deltaCharBudget) ||
    deltaCharBudget <= 0 ||
    !Number.isFinite(turnTimeoutMinutes) ||
    turnTimeoutMinutes <= 0
  ) {
    return null;
  }
  return {
    maxRounds,
    maxTurns,
    turnTimeoutMs: Math.round(turnTimeoutMinutes * 60_000),
    deltaCharBudget,
  };
}

function memberCombinationKey(member: RoomFormMemberDraft): string {
  return `${member.provider ?? ""}:${member.modelId}`;
}

function validateMembers(members: RoomFormMemberDraft[]): RoomMemberRowValidation[] {
  const seen = new Set<string>();
  // Map order keeps the first occurrence clean; later duplicates carry the error.
  return members.map((member) => {
    const key = memberCombinationKey(member);
    const complete = member.provider !== null && member.modelId.trim().length > 0;
    const duplicate = complete && seen.has(key);
    if (complete && !duplicate) {
      seen.add(key);
    }
    return {
      providerMissing: member.provider === null,
      modelMissing: member.provider !== null && member.modelId.trim().length === 0,
      duplicateCombination: duplicate,
    };
  });
}

function validateState(state: RoomFormState): RoomFormValidation {
  const memberValidation = validateMembers(state.members);
  return {
    nameMissing: state.name.trim().length === 0,
    topicMissing: state.topic.trim().length === 0,
    members: memberValidation,
    moderator: {
      providerMissing: state.moderator.provider === null,
      modelMissing:
        state.moderator.provider !== null && state.moderator.modelId.trim().length === 0,
    },
    artifactPath: validateRoomArtifactPath(state.artifactPath),
    limitsInvalid: parseRoomLimits(state.limits) === null,
  };
}

function validationPasses(validation: RoomFormValidation): boolean {
  if (validation.nameMissing || validation.topicMissing) return false;
  if (validation.artifactPath !== null || validation.limitsInvalid) return false;
  if (validation.moderator.providerMissing || validation.moderator.modelMissing) return false;
  return validation.members.every(
    (row) => !row.providerMissing && !row.modelMissing && !row.duplicateCombination,
  );
}

function withDerivedState(state: RoomFormState): RoomFormState {
  const validation = validateState(state);
  return { ...state, validation, canSubmit: validationPasses(validation) };
}

export function openRoomForm(): RoomFormModel {
  let memberRowCounter = 0;
  const nextRowId = () => `member-${++memberRowCounter}`;

  let state = withDerivedState({
    name: "",
    topic: "",
    members: [
      {
        rowId: nextRowId(),
        provider: null,
        modelId: "",
        persona: "",
        roleId: null,
        displayName: "",
      },
      {
        rowId: nextRowId(),
        provider: null,
        modelId: "",
        persona: "",
        roleId: null,
        displayName: "",
      },
    ],
    moderator: { provider: null, modelId: "", modeId: null },
    artifactPath: buildDefaultArtifactPath(""),
    artifactPathTouched: false,
    limits: defaultLimitsDraft(),
    limitsExpanded: false,
    providerSnapshotStatus: "connecting",
    providerEntries: null,
    submitError: null,
    canSubmit: false,
    validation: {
      nameMissing: true,
      topicMissing: true,
      members: [],
      moderator: { providerMissing: true, modelMissing: false },
      artifactPath: null,
      limitsInvalid: false,
    },
  });
  const listeners = new Set<() => void>();

  function publish(next: RoomFormState): void {
    state = next;
    for (const listener of listeners) listener();
  }

  function updateMembers(rowId: string, patch: Partial<RoomFormMemberDraft>): void {
    publish(
      withDerivedState({
        ...state,
        members: state.members.map((member) =>
          member.rowId === rowId ? { ...member, ...patch } : member,
        ),
      }),
    );
  }

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    close() {
      listeners.clear();
    },
    setProviderSnapshotStatus(status) {
      publish(withDerivedState({ ...state, providerSnapshotStatus: status }));
    },
    applyProviderSnapshot(entries) {
      publish(
        withDerivedState({ ...state, providerEntries: entries, providerSnapshotStatus: "loaded" }),
      );
    },
    setName(value) {
      const artifactPath = state.artifactPathTouched
        ? state.artifactPath
        : buildDefaultArtifactPath(value);
      publish(withDerivedState({ ...state, name: value, artifactPath }));
    },
    setTopic(value) {
      publish(withDerivedState({ ...state, topic: value }));
    },
    addMember() {
      if (state.members.length >= MAX_MEMBERS) return;
      publish(
        withDerivedState({
          ...state,
          members: [
            ...state.members,
            {
              rowId: nextRowId(),
              provider: null,
              modelId: "",
              persona: "",
              roleId: null,
              displayName: "",
            },
          ],
        }),
      );
    },
    removeMember(rowId) {
      if (state.members.length <= MIN_MEMBERS) return;
      publish(
        withDerivedState({
          ...state,
          members: state.members.filter((member) => member.rowId !== rowId),
        }),
      );
    },
    setMemberSelection(rowId, provider, modelId) {
      updateMembers(rowId, { provider, modelId });
    },
    setMemberRolePreset(rowId, roleId) {
      // A preset fills the display name with its label; "custom" keeps the
      // current text so a user switching back keeps what they typed (§5.5).
      const label = roleId ? roomRolePresetLabel(roleId) : null;
      updateMembers(rowId, label ? { roleId, displayName: label } : { roleId });
    },
    setMemberDisplayName(rowId, value) {
      updateMembers(rowId, { displayName: value });
    },
    setMemberPersona(rowId, value) {
      updateMembers(rowId, { persona: value });
    },
    setModeratorSelection(provider, modelId) {
      publish(withDerivedState({ ...state, moderator: { ...state.moderator, provider, modelId } }));
    },
    setModeratorMode(modeId) {
      publish(withDerivedState({ ...state, moderator: { ...state.moderator, modeId } }));
    },
    setArtifactPath(value) {
      publish(withDerivedState({ ...state, artifactPath: value, artifactPathTouched: true }));
    },
    setLimitField(field, value) {
      publish(withDerivedState({ ...state, limits: { ...state.limits, [field]: value } }));
    },
    setLimitsExpanded(expanded) {
      publish({ ...state, limitsExpanded: expanded });
    },
    setSubmitError(value) {
      publish({ ...state, submitError: value });
    },
    toCreateInput() {
      if (!state.canSubmit) {
        return null;
      }
      const limits = parseRoomLimits(state.limits);
      if (!limits) {
        return null;
      }
      return {
        name: state.name.trim(),
        topic: state.topic.trim(),
        moderator: {
          provider: state.moderator.provider!,
          model: state.moderator.modelId,
          modeId: state.moderator.modeId,
        },
        members: state.members.map((member) => {
          const displayName = member.displayName.trim();
          return {
            provider: member.provider!,
            model: member.modelId,
            modeId: null,
            persona: member.persona.trim(),
            ...(displayName ? { displayName } : {}),
            ...(member.roleId ? { roleId: member.roleId } : {}),
          };
        }),
        artifactPath: state.artifactPath.trim(),
        limits,
      };
    },
  };
}
