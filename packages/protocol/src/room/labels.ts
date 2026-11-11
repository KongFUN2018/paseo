import type { RoomMember } from "./types.js";

/**
 * Name shown for a room member wherever a human reads it: the agent session
 * title, transcripts, seats. Precedence is the explicit `displayName`, then the
 * role preset label, then a stable positional fallback.
 *
 * The fallback keeps "Member N" so a member with neither a display name nor a
 * role is still distinguishable from its siblings instead of every such member
 * collapsing onto the same label.
 */
export function roomMemberLabel(member: Pick<RoomMember, "id" | "displayName" | "roleId">): string {
  const displayName = member.displayName?.trim();
  if (displayName) return displayName;
  if (member.roleId) return member.roleId;
  return legacyMemberLabel(member.id);
}

/** Positional label for members created before display names existed. */
export function legacyMemberLabel(memberId: string): string {
  const match = /^member[_-](\d+)$/.exec(memberId);
  return match ? `Member ${match[1]}` : memberId;
}

/**
 * Agent session title for a room member, e.g. `架构师 · 出账方案评审`.
 *
 * Titles are what the sidebar and the agent tab list show, so a role name reads
 * far better than a wire id like `member_3`. Members without a role name keep a
 * positional suffix to stay unique.
 */
export function roomMemberAgentTitle(
  member: Pick<RoomMember, "id" | "displayName" | "roleId">,
  roomName: string,
): string {
  const label = roomMemberLabel(member);
  const trimmedRoomName = roomName.trim();
  return trimmedRoomName ? `${label} · ${trimmedRoomName}` : label;
}

/** Agent session title for the room moderator. */
export function roomModeratorAgentTitle(roomName: string): string {
  const trimmedRoomName = roomName.trim();
  return trimmedRoomName ? `主持人 · ${trimmedRoomName}` : "主持人";
}

/**
 * Whether a title is a title this module generated *before* sessions were named
 * by role, i.e. exactly `Room member member_N · <room>` or `Room moderator ·
 * <room>`. Anything else is either the current format or a title the user typed
 * by hand, and must be left alone.
 *
 * Matching the whole string (not a prefix) is what keeps a user's own
 * "Room member onboarding notes" rename safe from being rewritten.
 */
export function isLegacyRoomAgentTitle(title: string): boolean {
  const trimmed = title.trim();
  return (
    /^Room member member[_-]\d+(?: · .*)?$/u.test(trimmed) ||
    /^Room moderator(?: · .*)?$/u.test(trimmed)
  );
}
