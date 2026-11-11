import { describe, expect, test } from "vitest";
import {
  isLegacyRoomAgentTitle,
  legacyMemberLabel,
  roomMemberAgentTitle,
  roomMemberLabel,
  roomModeratorAgentTitle,
} from "./labels.js";

describe("room member labels", () => {
  test("an explicit display name wins over the role", () => {
    expect(roomMemberLabel({ id: "member_1", displayName: "老王", roleId: "dba" })).toBe("老王");
  });

  test("falls back to the role preset label when no display name exists", () => {
    expect(roomMemberLabel({ id: "member_2", roleId: "architect" })).toBe("architect");
  });

  test("keeps positional labels distinct for members with neither name nor role", () => {
    const first = roomMemberLabel({ id: "member_1" });
    const second = roomMemberLabel({ id: "member_2" });
    expect(first).not.toBe(second);
    expect(first).toBe("Member 1");
    expect(second).toBe("Member 2");
  });

  test("agent titles use the role name, not the wire id", () => {
    const title = roomMemberAgentTitle({ id: "member_3", displayName: "架构师" }, "出账方案评审");
    expect(title).toBe("架构师 · 出账方案评审");
    expect(title).not.toContain("member_3");
  });

  test("agent titles stay unique for unnamed members", () => {
    const a = roomMemberAgentTitle({ id: "member_1" }, "评审");
    const b = roomMemberAgentTitle({ id: "member_2" }, "评审");
    expect(a).toBe("Member 1 · 评审");
    expect(b).toBe("Member 2 · 评审");
    expect(a).not.toBe(b);
  });

  test("an empty room name does not leave a dangling separator", () => {
    expect(roomMemberAgentTitle({ id: "member_1", displayName: "DBA" }, "   ")).toBe("DBA");
  });

  test("moderator title reads as a role", () => {
    expect(roomModeratorAgentTitle("架构评审")).toBe("主持人 · 架构评审");
    expect(roomModeratorAgentTitle("")).toBe("主持人");
  });

  test("legacy ids pass through untouched", () => {
    expect(legacyMemberLabel("custom-id")).toBe("custom-id");
    expect(legacyMemberLabel("member-7")).toBe("Member 7");
  });
});

describe("legacy title detection", () => {
  test("recognises the titles older versions generated", () => {
    expect(isLegacyRoomAgentTitle("Room member member_3 · 架构评审")).toBe(true);
    expect(isLegacyRoomAgentTitle("Room member member-1")).toBe(true);
    expect(isLegacyRoomAgentTitle("Room moderator · 架构评审")).toBe(true);
    expect(isLegacyRoomAgentTitle("Room moderator")).toBe(true);
  });

  test("leaves current and hand-written titles alone", () => {
    expect(isLegacyRoomAgentTitle("架构师 · 架构评审")).toBe(false);
    expect(isLegacyRoomAgentTitle("主持人 · 架构评审")).toBe(false);
    // A prefix alone must not be enough: this is a user rename.
    expect(isLegacyRoomAgentTitle("Room member onboarding notes")).toBe(false);
    expect(isLegacyRoomAgentTitle("Room moderator planning")).toBe(false);
    expect(isLegacyRoomAgentTitle("")).toBe(false);
  });
});
