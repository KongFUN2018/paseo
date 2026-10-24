import { beforeEach, describe, expect, it } from "vitest";
import {
  applyRoomPartial,
  clearRoomStreams,
  getRoomStreamEntry,
  useRoomStreamStore,
} from "@/rooms/room-stream-store";

function resetStore() {
  useRoomStreamStore.setState({ byRoomKey: {} });
}

beforeEach(resetStore);

describe("room stream store", () => {
  it("stores the accumulated text snapshot and tool call count", () => {
    applyRoomPartial({
      serverId: "s1",
      roomId: "r1",
      memberId: "member_1",
      text: "结论",
      toolCalls: 0,
      done: false,
    });
    applyRoomPartial({
      serverId: "s1",
      roomId: "r1",
      memberId: "member_1",
      text: "结论：可行",
      toolCalls: 2,
      done: false,
    });

    const entry = getRoomStreamEntry("s1", "r1", "member_1");
    // text is an accumulated snapshot, not a delta: the latest value wins as-is.
    expect(entry?.text).toBe("结论：可行");
    expect(entry?.toolCalls).toBe(2);
    expect(entry?.done).toBe(false);
  });

  it("marks the entry done at the terminal flush and keeps it for seat convergence", () => {
    applyRoomPartial({
      serverId: "s1",
      roomId: "r1",
      memberId: "member_1",
      text: "结论",
      toolCalls: 0,
      done: false,
    });
    applyRoomPartial({
      serverId: "s1",
      roomId: "r1",
      memberId: "member_1",
      text: "结论：可行",
      toolCalls: 1,
      done: true,
    });

    const entry = getRoomStreamEntry("s1", "r1", "member_1");
    expect(entry?.done).toBe(true);
    expect(entry?.text).toBe("结论：可行");
  });

  it("resets a done entry when the member's next turn starts streaming", () => {
    applyRoomPartial({
      serverId: "s1",
      roomId: "r1",
      memberId: "member_1",
      text: "第一轮发言",
      toolCalls: 3,
      done: true,
    });
    applyRoomPartial({
      serverId: "s1",
      roomId: "r1",
      memberId: "member_1",
      text: "",
      toolCalls: 0,
      done: false,
    });

    const entry = getRoomStreamEntry("s1", "r1", "member_1");
    expect(entry?.done).toBe(false);
    expect(entry?.text).toBe("");
    expect(entry?.toolCalls).toBe(0);
  });

  it("isolates entries by serverId:roomId:memberId", () => {
    applyRoomPartial({
      serverId: "s1",
      roomId: "r1",
      memberId: "member_1",
      text: "a",
      toolCalls: 0,
      done: false,
    });
    applyRoomPartial({
      serverId: "s1",
      roomId: "r1",
      memberId: "member_2",
      text: "b",
      toolCalls: 1,
      done: false,
    });
    applyRoomPartial({
      serverId: "s1",
      roomId: "r2",
      memberId: "member_1",
      text: "c",
      toolCalls: 0,
      done: false,
    });
    applyRoomPartial({
      serverId: "s2",
      roomId: "r1",
      memberId: "member_1",
      text: "d",
      toolCalls: 0,
      done: false,
    });

    expect(getRoomStreamEntry("s1", "r1", "member_1")?.text).toBe("a");
    expect(getRoomStreamEntry("s1", "r1", "member_2")?.text).toBe("b");
    expect(getRoomStreamEntry("s1", "r2", "member_1")?.text).toBe("c");
    expect(getRoomStreamEntry("s2", "r1", "member_1")?.text).toBe("d");
    expect(getRoomStreamEntry("s1", "r1", "member_3")).toBeUndefined();
  });

  it("caps the streamed text at the defensive limit", () => {
    applyRoomPartial({
      serverId: "s1",
      roomId: "r1",
      memberId: "member_1",
      text: "x".repeat(9000),
      toolCalls: 0,
      done: false,
    });
    expect(getRoomStreamEntry("s1", "r1", "member_1")?.text).toHaveLength(8000);
  });

  it("clears one room's streams without touching the others", () => {
    applyRoomPartial({
      serverId: "s1",
      roomId: "r1",
      memberId: "member_1",
      text: "a",
      toolCalls: 0,
      done: false,
    });
    applyRoomPartial({
      serverId: "s1",
      roomId: "r2",
      memberId: "member_1",
      text: "b",
      toolCalls: 0,
      done: false,
    });

    clearRoomStreams("s1", "r1");

    expect(getRoomStreamEntry("s1", "r1", "member_1")).toBeUndefined();
    expect(getRoomStreamEntry("s1", "r2", "member_1")?.text).toBe("b");
  });

  it("skips publishing when nothing changed", () => {
    applyRoomPartial({
      serverId: "s1",
      roomId: "r1",
      memberId: "member_1",
      text: "a",
      toolCalls: 0,
      done: false,
    });
    const before = useRoomStreamStore.getState().byRoomKey["s1:r1"];
    applyRoomPartial({
      serverId: "s1",
      roomId: "r1",
      memberId: "member_1",
      text: "a",
      toolCalls: 0,
      done: false,
    });
    expect(useRoomStreamStore.getState().byRoomKey["s1:r1"]).toBe(before);
  });
});
