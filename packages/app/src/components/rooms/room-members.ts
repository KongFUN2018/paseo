import type { RoomMember } from "@getpaseo/protocol/room/types";

/**
 * Display name for a room member (design §4.3): the optional wire
 * `displayName` wins; legacy rooms fall back to the derived "Member N" label.
 */
export function roomMemberDisplayName(member: Pick<RoomMember, "id" | "displayName">): string {
  const displayName = member.displayName?.trim();
  return displayName ? displayName : memberLabel(member.id);
}

/** First grapheme of the display name, for the identity-color avatar. */
export function roomMemberAvatarChar(member: Pick<RoomMember, "id" | "displayName">): string {
  return [...roomMemberDisplayName(member)][0] ?? "?";
}

/** `provider / model` subtitle shared by seats, feed rows and the files drawer. */
export function roomProviderModelLabel(provider: string, model: string | null): string {
  return model ? `${provider} / ${model}` : provider;
}

/** Legacy label for pre-refactor members without a displayName (design §4.3). */
export function memberLabel(memberId: string): string {
  const match = /^member[_-](\d+)$/.exec(memberId);
  return match ? `Member ${match[1]}` : memberId;
}
