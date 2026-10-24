/** @vitest-environment jsdom */
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import {
  applyRoomPartial,
  clearRoomStreams,
  useRoomStreamEntries,
} from "@/rooms/room-stream-store";

beforeEach(() => {
  clearRoomStreams("s1", "room_1");
  clearRoomStreams("s1", "room_2");
});

describe("useRoomStreamEntries", () => {
  it("returns a stable snapshot while the room has no partials", () => {
    const { result, rerender } = renderHook(() => useRoomStreamEntries("s1", "room_1"));
    const first = result.current;
    expect(first).toEqual({});
    rerender();
    // Identity must hold across renders: a fresh `{}` per getSnapshot makes
    // React loop forever (the useSyncExternalStore instability guard).
    expect(result.current).toBe(first);
  });

  it("never produces a fresh object for a null serverId", () => {
    const { result, rerender } = renderHook(() => useRoomStreamEntries(null, "room_1"));
    const first = result.current;
    rerender();
    expect(result.current).toBe(first);
  });

  it("picks up partials and keeps identity when a partial changes nothing", () => {
    const { result } = renderHook(() => useRoomStreamEntries("s1", "room_1"));
    act(() => {
      applyRoomPartial({
        serverId: "s1",
        roomId: "room_1",
        memberId: "member_1",
        text: "结论",
        toolCalls: 0,
        done: false,
      });
    });
    expect(result.current.member_1?.text).toBe("结论");
    const withEntry = result.current;
    act(() => {
      applyRoomPartial({
        serverId: "s1",
        roomId: "room_1",
        memberId: "member_1",
        text: "结论",
        toolCalls: 0,
        done: false,
      });
    });
    // The store skips publishing a no-op partial; the hook must not re-render.
    expect(result.current).toBe(withEntry);
  });

  it("stays empty when partials land under another room key", () => {
    const { result } = renderHook(() => useRoomStreamEntries("s1", "room_1"));
    act(() => {
      applyRoomPartial({
        serverId: "s1",
        roomId: "room_2",
        memberId: "member_1",
        text: "other room",
        toolCalls: 0,
        done: false,
      });
    });
    expect(result.current).toEqual({});
  });
});
