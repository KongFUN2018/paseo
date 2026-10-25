import type { SessionOutboundMessage } from "@getpaseo/protocol/messages";
import { applyRoomPartial } from "@/rooms/room-stream-store";

/**
 * session-context subscription body for the `room_partial_update` push
 * (design §6.5). Extracted from session-context so the wire→store chain has a
 * testable seam: the chain regression test drives a real DaemonClient mock
 * transport into this handler and asserts the stream store ingested the data.
 */
export function handleRoomPartialPush(serverId: string, message: SessionOutboundMessage): void {
  if (message.type !== "room_partial_update") return;
  applyRoomPartial({
    serverId,
    roomId: message.payload.roomId,
    memberId: message.payload.memberId,
    text: message.payload.text,
    toolCalls: message.payload.toolCalls,
    done: message.payload.done,
  });
}
