import type { RoomMember } from "@getpaseo/protocol/room/types";
import { roomMemberLabel } from "@getpaseo/protocol/room/labels";

/**
 * Display name for a room member (design §4.3): the optional wire
 * `displayName` wins, then the role preset label, then the derived
 * "Member N" label. Shares the precedence with the server so the seat, the
 * feed and the agent session title never disagree.
 */
export function roomMemberDisplayName(member: Pick<RoomMember, "id" | "displayName" | "roleId">): string {
  return roomMemberLabel(member);
}

/** First grapheme of the display name, for the identity-color avatar. */
export function roomMemberAvatarChar(
  member: Pick<RoomMember, "id" | "displayName" | "roleId">,
): string {
  return [...roomMemberDisplayName(member)][0] ?? "?";
}

/** `provider / model` subtitle shared by seats, feed rows and the files drawer. */
export function roomProviderModelLabel(provider: string, model: string | null): string {
  return model ? `${provider} / ${model}` : provider;
}

/** Legacy label for pre-refactor members without a displayName (design §4.3). */
export { legacyMemberLabel as memberLabel } from "@getpaseo/protocol/room/labels";
