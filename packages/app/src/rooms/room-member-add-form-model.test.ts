import { describe, expect, it } from "vitest";
import type { ProviderSnapshotEntry } from "@getpaseo/protocol/agent-types";
import { openRoomMemberAddForm } from "@/rooms/room-member-add-form-model";
import { ROOM_ROLE_PRESETS } from "@/rooms/role-presets";

const SNAPSHOT: ProviderSnapshotEntry[] = [
  {
    provider: "claude",
    status: "ready",
    models: [{ id: "claude-opus-5-5", label: "Opus" }],
  } as unknown as ProviderSnapshotEntry,
];

function fillValidForm(model: ReturnType<typeof openRoomMemberAddForm>) {
  model.setDisplayName("运营分析师");
  model.setProviderSelection("claude", "claude-opus-5-5");
  return model;
}

describe("room member add form model", () => {
  it("opens idle with empty fields and connecting provider snapshot", () => {
    const model = openRoomMemberAddForm();
    const state = model.getState();
    expect(state.status).toBe("idle");
    expect(state.providerSnapshotStatus).toBe("connecting");
    expect(state.roleId).toBeNull();
    expect(state.canSubmit).toBe(false);
    expect(state.validation.displayNameMissing).toBe(true);
    expect(state.validation.providerMissing).toBe(true);
  });

  it("derives canSubmit from display name, provider and model", () => {
    const model = openRoomMemberAddForm();
    model.setDisplayName("运营分析师");
    expect(model.getState().canSubmit).toBe(false); // provider missing

    model.setProviderSelection("claude", "");
    expect(model.getState().validation.modelMissing).toBe(true);
    expect(model.getState().canSubmit).toBe(false);

    model.setProviderSelection("claude", "claude-opus-5-5");
    expect(model.getState().canSubmit).toBe(true);
  });

  it("fills the display name from a role preset label and records the roleId", () => {
    const model = openRoomMemberAddForm();
    model.selectRolePreset("dba");
    const state = model.getState();
    expect(state.roleId).toBe("dba");
    expect(state.displayName).toBe("DBA");
    expect(state.canSubmit).toBe(false); // provider still missing

    // The auto-filled name can be edited afterwards.
    model.setDisplayName("老王（DBA）");
    expect(model.getState().displayName).toBe("老王（DBA）");
    expect(model.getState().roleId).toBe("dba");
  });

  it("keeps the typed display name when switching back to custom", () => {
    const model = openRoomMemberAddForm();
    model.selectRolePreset("architect");
    model.selectRolePreset("product");
    expect(model.getState().displayName).toBe("业务/产品");

    model.selectRolePreset(null);
    expect(model.getState().roleId).toBeNull();
    expect(model.getState().displayName).toBe("业务/产品");
  });

  it("covers every server role preset id", () => {
    const model = openRoomMemberAddForm();
    for (const preset of ROOM_ROLE_PRESETS) {
      model.selectRolePreset(preset.roleId);
      expect(model.getState().roleId).toBe(preset.roleId);
      expect(model.getState().displayName).toBe(preset.label);
    }
  });

  it("builds the add input with optional roleId only when a preset is chosen", () => {
    const model = fillValidForm(openRoomMemberAddForm());
    const custom = model.toAddInput();
    expect(custom).toEqual({
      provider: "claude",
      model: "claude-opus-5-5",
      modeId: null,
      persona: "",
      displayName: "运营分析师",
    });

    model.setPersona(" 关注渠道与合同口径 ");
    model.selectRolePreset("product");
    const preset = model.toAddInput();
    expect(preset).toEqual({
      provider: "claude",
      model: "claude-opus-5-5",
      modeId: null,
      persona: "关注渠道与合同口径",
      displayName: "业务/产品",
      roleId: "product",
    });
  });

  it("returns null from toAddInput while invalid", () => {
    const model = openRoomMemberAddForm();
    expect(model.toAddInput()).toBeNull();
  });

  it("walks the idle → submitting → error → retry lifecycle without losing input", () => {
    const model = fillValidForm(openRoomMemberAddForm());
    model.setSubmitStatus("submitting");
    expect(model.getState().status).toBe("submitting");

    model.setSubmitStatus("error");
    model.setSubmitError("provider does not support session persistence");
    expect(model.getState().status).toBe("error");
    expect(model.getState().submitError).toBe("provider does not support session persistence");
    // Inputs survive: retry is a plain re-submit.
    expect(model.getState().displayName).toBe("运营分析师");
    expect(model.getState().canSubmit).toBe(true);

    model.setSubmitError(null);
    model.setSubmitStatus("submitting");
    model.setSubmitStatus("done");
    expect(model.getState().status).toBe("done");
  });

  it("accepts the provider snapshot as late data", () => {
    const model = openRoomMemberAddForm();
    model.applyProviderSnapshot(SNAPSHOT);
    expect(model.getState().providerSnapshotStatus).toBe("loaded");
    expect(model.getState().providerEntries).toEqual(SNAPSHOT);
  });
});
