import type { AgentProvider, ProviderSnapshotEntry } from "@getpaseo/protocol/agent-types";
import { roomRolePresetLabel } from "@/rooms/role-presets";

/**
 * Form model for adding a member mid-room (design §4.5). Plain TypeScript, no
 * React: `openRoomMemberAddForm()` constructs a fresh instance per open, the
 * sheet renders state and dispatches intent, and the submit lifecycle is
 * `idle → submitting → done | error` with error retryable in place.
 */
export type RoomMemberAddStatus = "idle" | "submitting" | "done" | "error";

export interface RoomMemberAddValidation {
  displayNameMissing: boolean;
  providerMissing: boolean;
  modelMissing: boolean;
}

export interface RoomMemberAddFormState {
  displayName: string;
  /** Selected role preset; null is the "custom" choice. */
  roleId: string | null;
  persona: string;
  provider: AgentProvider | null;
  modelId: string;
  providerSnapshotStatus: "connecting" | "loaded";
  providerEntries: ProviderSnapshotEntry[] | null;
  status: RoomMemberAddStatus;
  submitError: string | null;
  validation: RoomMemberAddValidation;
  canSubmit: boolean;
}

export interface RoomMemberAddInput {
  provider: AgentProvider;
  model: string | null;
  modeId: null;
  persona: string;
  displayName: string;
  roleId?: string;
}

export interface RoomMemberAddFormModel {
  getState(): RoomMemberAddFormState;
  subscribe(listener: () => void): () => void;
  close(): void;
  setProviderSnapshotStatus(status: "connecting" | "loaded"): void;
  applyProviderSnapshot(entries: ProviderSnapshotEntry[]): void;
  setDisplayName(value: string): void;
  /** Selecting a preset auto-fills the display name with its label (§5.5). */
  selectRolePreset(roleId: string | null): void;
  setPersona(value: string): void;
  setProviderSelection(provider: AgentProvider, modelId: string): void;
  setSubmitStatus(status: RoomMemberAddStatus): void;
  setSubmitError(value: string | null): void;
  toAddInput(): RoomMemberAddInput | null;
}

function validateState(state: RoomMemberAddFormState): RoomMemberAddValidation {
  return {
    displayNameMissing: state.displayName.trim().length === 0,
    providerMissing: state.provider === null,
    modelMissing: state.provider !== null && state.modelId.trim().length === 0,
  };
}

function validationPasses(validation: RoomMemberAddValidation): boolean {
  return !validation.displayNameMissing && !validation.providerMissing && !validation.modelMissing;
}

function withDerivedState(state: RoomMemberAddFormState): RoomMemberAddFormState {
  const validation = validateState(state);
  return { ...state, validation, canSubmit: validationPasses(validation) };
}

export function openRoomMemberAddForm(): RoomMemberAddFormModel {
  let state = withDerivedState({
    displayName: "",
    roleId: null,
    persona: "",
    provider: null,
    modelId: "",
    providerSnapshotStatus: "connecting",
    providerEntries: null,
    status: "idle",
    submitError: null,
    canSubmit: false,
    validation: { displayNameMissing: true, providerMissing: true, modelMissing: false },
  });
  const listeners = new Set<() => void>();

  function publish(next: RoomMemberAddFormState): void {
    state = next;
    for (const listener of listeners) listener();
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
    setDisplayName(value) {
      publish(withDerivedState({ ...state, displayName: value }));
    },
    selectRolePreset(roleId) {
      // A preset fills the display name with its label; "custom" leaves the
      // current text so a user switching back keeps what they typed (§4.5).
      const label = roleId ? roomRolePresetLabel(roleId) : null;
      publish(
        withDerivedState({
          ...state,
          roleId,
          displayName: label ?? state.displayName,
        }),
      );
    },
    setPersona(value) {
      publish(withDerivedState({ ...state, persona: value }));
    },
    setProviderSelection(provider, modelId) {
      publish(withDerivedState({ ...state, provider, modelId }));
    },
    setSubmitStatus(status) {
      publish({ ...state, status });
    },
    setSubmitError(value) {
      publish({ ...state, submitError: value });
    },
    toAddInput() {
      if (!state.canSubmit || state.provider === null) {
        return null;
      }
      return {
        provider: state.provider,
        model: state.modelId.trim() || null,
        modeId: null,
        persona: state.persona.trim(),
        displayName: state.displayName.trim(),
        ...(state.roleId ? { roleId: state.roleId } : {}),
      };
    },
  };
}
