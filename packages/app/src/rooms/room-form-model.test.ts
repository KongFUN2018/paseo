import { describe, expect, it } from "vitest";
import { DEFAULT_ROOM_LIMITS } from "@getpaseo/protocol/room/types";
import {
  buildDefaultArtifactPath,
  openRoomForm,
  validateRoomArtifactPath,
} from "@/rooms/room-form-model";

function fillValidForm() {
  const model = openRoomForm();
  model.setName("Architecture review");
  model.setTopic("Pick a message queue for the settlement service");
  const [first, second] = model.getState().members;
  model.setMemberSelection(first.rowId, "claude", "claude-opus-5-5");
  model.setMemberSelection(second.rowId, "codex", "gpt-5.1");
  model.setModeratorSelection("claude", "claude-opus-5-5");
  return model;
}

describe("buildDefaultArtifactPath", () => {
  it("slugs the room name into the default artifact path", () => {
    expect(buildDefaultArtifactPath("Architecture Review")).toBe(
      ".paseo/rooms/architecture-review/summary.md",
    );
  });

  it("keeps unicode letters in the slug", () => {
    expect(buildDefaultArtifactPath("架构 评审")).toBe(".paseo/rooms/架构-评审/summary.md");
  });

  it("falls back to room when the name produces no slug characters", () => {
    expect(buildDefaultArtifactPath("!!!")).toBe(".paseo/rooms/room/summary.md");
  });
});

describe("validateRoomArtifactPath", () => {
  it("accepts a workspace-relative path", () => {
    expect(validateRoomArtifactPath(".paseo/rooms/x/summary.md")).toBeNull();
    expect(validateRoomArtifactPath("docs/summary.md")).toBeNull();
  });

  it("rejects empty and whitespace-only paths", () => {
    expect(validateRoomArtifactPath("")).toBe("required");
    expect(validateRoomArtifactPath("   ")).toBe("required");
  });

  it("rejects absolute paths and drive letters", () => {
    expect(validateRoomArtifactPath("/etc/passwd")).toBe("notRelative");
    expect(validateRoomArtifactPath("\\windows\\system32")).toBe("notRelative");
    expect(validateRoomArtifactPath("C:\\Users\\summary.md")).toBe("notRelative");
    expect(validateRoomArtifactPath("d:/tmp/summary.md")).toBe("notRelative");
  });

  it("rejects parent-directory segments", () => {
    expect(validateRoomArtifactPath("../outside/summary.md")).toBe("notRelative");
    expect(validateRoomArtifactPath("docs/../../outside.md")).toBe("notRelative");
    expect(validateRoomArtifactPath("docs\\..\\outside.md")).toBe("notRelative");
  });
});

describe("room form model", () => {
  it("opens with two empty member rows and defaults from DEFAULT_ROOM_LIMITS", () => {
    const model = openRoomForm();
    const state = model.getState();
    expect(state.members).toHaveLength(2);
    expect(state.limits.maxRounds).toBe(String(DEFAULT_ROOM_LIMITS.maxRounds));
    expect(state.limits.turnTimeoutMinutes).toBe("15");
    expect(state.providerSnapshotStatus).toBe("connecting");
    expect(state.canSubmit).toBe(false);
  });

  it("derives the artifact path from the name until the user edits it", () => {
    const model = openRoomForm();
    model.setName("Architecture Review");
    expect(model.getState().artifactPath).toBe(".paseo/rooms/architecture-review/summary.md");

    model.setArtifactPath("docs/my-summary.md");
    model.setName("New Name");
    expect(model.getState().artifactPath).toBe("docs/my-summary.md");
  });

  it("clamps members between 2 and 4 rows", () => {
    const model = openRoomForm();
    model.addMember();
    model.addMember();
    expect(model.getState().members).toHaveLength(4);
    model.addMember();
    expect(model.getState().members).toHaveLength(4);

    model.removeMember(model.getState().members[0].rowId);
    model.removeMember(model.getState().members[0].rowId);
    expect(model.getState().members).toHaveLength(2);
    model.removeMember(model.getState().members[0].rowId);
    expect(model.getState().members).toHaveLength(2);
  });

  it("flags duplicate (provider, model) combinations between members", () => {
    const model = openRoomForm();
    const [first, second] = model.getState().members;
    model.setMemberSelection(first.rowId, "claude", "claude-opus-5-5");
    model.setMemberSelection(second.rowId, "claude", "claude-opus-5-5");

    const duplicateRow = model.getState().validation.members[1];
    expect(duplicateRow.duplicateCombination).toBe(true);
    expect(model.getState().canSubmit).toBe(false);

    model.setMemberSelection(second.rowId, "claude", "claude-sonnet-5-5");
    expect(model.getState().validation.members.every((row) => !row.duplicateCombination)).toBe(
      true,
    );
  });

  it("allows the same provider across members when models differ", () => {
    const model = openRoomForm();
    const [first, second] = model.getState().members;
    model.setMemberSelection(first.rowId, "claude", "claude-opus-5-5");
    model.setMemberSelection(second.rowId, "claude", "claude-sonnet-5-5");

    expect(model.getState().validation.members.every((row) => !row.duplicateCombination)).toBe(
      true,
    );
  });

  it("canSubmit requires name, topic, members, moderator, and a valid artifact path", () => {
    const model = openRoomForm();
    const [first, second] = model.getState().members;
    model.setMemberSelection(first.rowId, "claude", "claude-opus-5-5");
    model.setMemberSelection(second.rowId, "codex", "gpt-5.1");
    model.setModeratorSelection("claude", "claude-opus-5-5");
    model.setTopic("Pick a queue");

    expect(model.getState().canSubmit).toBe(false); // no name yet

    model.setName("Review");
    expect(model.getState().canSubmit).toBe(true);

    model.setArtifactPath("C:/abs/path.md");
    expect(model.getState().canSubmit).toBe(false);

    model.setArtifactPath(".paseo/rooms/review/summary.md");
    expect(model.getState().canSubmit).toBe(true);
  });

  it("rejects invalid limit values", () => {
    const model = fillValidForm();
    expect(model.getState().canSubmit).toBe(true);

    model.setLimitField("maxRounds", "0");
    expect(model.getState().canSubmit).toBe(false);
    expect(model.getState().validation.limitsInvalid).toBe(true);

    model.setLimitField("maxRounds", "8");
    expect(model.getState().canSubmit).toBe(true);

    model.setLimitField("turnTimeoutMinutes", "abc");
    expect(model.getState().canSubmit).toBe(false);
  });

  it("builds the create input from a valid form", () => {
    const model = fillValidForm();
    model.setMemberPersona(model.getState().members[0].rowId, "Review reliability");

    const input = model.toCreateInput();
    expect(input).not.toBeNull();
    expect(input?.name).toBe("Architecture review");
    expect(input?.members).toHaveLength(2);
    expect(input?.members[0]).toEqual({
      provider: "claude",
      model: "claude-opus-5-5",
      modeId: null,
      persona: "Review reliability",
    });
    expect(input?.moderator.provider).toBe("claude");
    expect(input?.limits).toEqual(DEFAULT_ROOM_LIMITS);
    expect(input?.artifactPath).toBe(".paseo/rooms/architecture-review/summary.md");
  });

  it("returns null from toCreateInput while invalid", () => {
    const model = openRoomForm();
    expect(model.toCreateInput()).toBeNull();
  });

  it("keeps submit errors separate from field validation", () => {
    const model = fillValidForm();
    model.setSubmitError("workspace not found");
    expect(model.getState().submitError).toBe("workspace not found");
    expect(model.getState().canSubmit).toBe(true);
  });
});
