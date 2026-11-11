/** @vitest-environment jsdom */
import React from "react";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RoomRecord } from "@getpaseo/protocol/room/types";
import { applyRoomPartial, clearRoomStreams } from "@/rooms/room-stream-store";
// Initializes the real i18n instance (inline en resources) so useTranslation
// resolves strings exactly as the app does.
import { i18n } from "@/i18n/i18next";
import { RoomSeats } from "./room-seats";

vi.mock("react-native-reanimated", () => ({
  default: {
    View: "div",
    // The seat row is an Animated.ScrollView; jsdom needs a plain host element.
    ScrollView: "div",
  },
  Easing: { ease: "ease", inOut: (value: unknown) => value },
  useAnimatedStyle: (factory: () => unknown) => factory(),
  useSharedValue: (initial: number) => ({ value: initial }),
  withRepeat: (value: unknown) => value,
  withTiming: (value: unknown) => value,
  // The seat row scrolls horizontally; the boundary hook only reads offsets,
  // so a no-op handler keeps the real component tree renderable.
  useAnimatedScrollHandler: () => () => {},
}));

function buildRoom(overrides: Partial<RoomRecord> = {}): RoomRecord {
  return {
    id: "room_ab12",
    workspaceId: "ws_1",
    name: "Architecture review",
    topic: "Pick a message queue",
    status: "discussing",
    promptVersion: 2,
    moderator: { agentId: null, provider: "claude", model: null, modeId: null },
    members: [
      {
        id: "member_1",
        agentId: "agent_1",
        provider: "claude",
        model: "claude-opus-5-5",
        modeId: null,
        persona: "",
        status: "ready",
        joinedAt: "2026-10-24T10:00:00.000Z",
        lastDeliveredSeq: 0,
        turnCount: 1,
        displayName: "架构师",
      },
      {
        id: "member_2",
        agentId: "agent_2",
        provider: "codex",
        model: "gpt-5.1",
        modeId: null,
        persona: "",
        status: "ready",
        joinedAt: "2026-10-24T10:00:00.000Z",
        lastDeliveredSeq: 0,
        turnCount: 0,
      },
    ],
    turn: {
      index: 0,
      memberId: null,
      agentId: null,
      turnId: null,
      status: "idle",
      startedAt: null,
      deadlineAt: null,
      attempt: 0,
    },
    round: { index: 1, remainingMemberIds: [] },
    transcript: [],
    interjections: [],
    lastSeq: 0,
    limits: { maxRounds: 6, maxTurns: 24, turnTimeoutMs: 900000, deltaCharBudget: 24000 },
    artifactPath: ".paseo/rooms/architecture-review/summary.md",
    summary: null,
    createdAt: "2026-10-24T10:00:00.000Z",
    updatedAt: "2026-10-24T10:00:00.000Z",
    closedAt: null,
    closedReason: null,
    ...overrides,
  };
}

const noop = () => {};

function renderSeats(room: RoomRecord) {
  return render(<RoomSeats room={room} serverId="s1" onOpenAgent={noop} onAddMember={noop} />);
}

beforeEach(() => {
  clearRoomStreams("s1", "room_ab12");
});

// Vitest globals are off in this project, so RTL's auto-cleanup never registers.
afterEach(cleanup);

describe("RoomSeats", () => {
  it("has translations loaded before rendering", () => {
    expect(i18n.isInitialized).toBe(true);
    expect(i18n.t("rooms.seat.invite")).toBe("Invite");
  });

  it("renders one identity seat per member plus the moderator and the add seat", () => {
    const view = renderSeats(buildRoom());
    expect(view.getByTestId("room-seat-member_1")).toBeTruthy();
    expect(view.getByTestId("room-seat-member_2")).toBeTruthy();
    expect(view.getByTestId("room-seat-moderator")).toBeTruthy();
    expect(view.getByTestId("room-seat-add")).toBeTruthy();
  });

  it("uses the displayName and keeps the turn count in the accessibility label", () => {
    const view = renderSeats(buildRoom());
    const seat = view.getByTestId("room-seat-member_1");
    const label = seat.getAttribute("aria-label") ?? seat.getAttribute("accessibilityLabel") ?? "";
    expect(label).toContain("架构师");
    expect(label).not.toContain("Member 1");
    expect(label).toContain("1 turn");
  });

  it("hides the add seat when the roster is full or the room is not joinable", () => {
    const fillTo = (room: RoomRecord, total: number) => {
      while (room.members.length < total) {
        const index = room.members.length + 1;
        room.members.push({ ...room.members[0], id: `member_${index}`, agentId: `agent_${index}` });
      }
      return room;
    };

    // Six is the cap: the invite seat disappears there, not at four.
    const full = fillTo(buildRoom(), 6);
    expect(full.members).toHaveLength(6);
    expect(renderSeats(full).queryByTestId("room-seat-add")).toBeNull();
    cleanup();

    // Five members still leave room for one more.
    const nearlyFull = fillTo(buildRoom(), 5);
    expect(renderSeats(nearlyFull).getByTestId("room-seat-add")).toBeTruthy();
    cleanup();

    const forming = buildRoom({ status: "forming" });
    expect(renderSeats(forming).queryByTestId("room-seat-add")).toBeNull();
  });

  it("hides the add seat for v1 rooms (mid-room joins are v2-only)", () => {
    // The server rejects the join authoritatively (§7.2.1 third patch);
    // hiding the entry is just guidance.
    const legacy = buildRoom({ promptVersion: 1 });
    expect(renderSeats(legacy).queryByTestId("room-seat-add")).toBeNull();

    const v2 = buildRoom({ promptVersion: 2 });
    expect(renderSeats(v2).getByTestId("room-seat-add")).toBeTruthy();
  });

  it("settles the speaking seat through researching → speaking as text streams in", () => {
    const room = buildRoom({
      turn: {
        index: 1,
        memberId: "member_1",
        agentId: "agent_1",
        turnId: null,
        status: "speaking",
        startedAt: new Date().toISOString(),
        deadlineAt: null,
        attempt: 0,
      },
    });
    const view = renderSeats(room);

    // No partial yet: researching.
    let label = view.getByTestId("room-seat-member_1").getAttribute("aria-label") ?? "";
    expect(label).toContain("Researching");

    // First characters arrive: speaking with the pulsing halo.
    act(() => {
      applyRoomPartial({
        serverId: "s1",
        roomId: "room_ab12",
        memberId: "member_1",
        text: "结论：可行",
        toolCalls: 0,
        done: false,
      });
    });
    label = view.getByTestId("room-seat-member_1").getAttribute("aria-label") ?? "";
    expect(label).toContain("Speaking");
  });

  it("shows the catch-up state for a member still reading the backlog", () => {
    const room = buildRoom();
    room.members[1] = { ...room.members[1], catchUpPending: true };
    const view = renderSeats(room);
    const label = view.getByTestId("room-seat-member_2").getAttribute("aria-label") ?? "";
    expect(label).toContain("Reading chat history");
  });

  it("keeps the rail collapsed by default and floats the full card on toggle", () => {
    const view = renderSeats(buildRoom());

    // Collapsed: avatars only. The avatar glyph stays (that is the identity
    // color cue), but the name and provider/model labels are gone.
    expect(view.getByTestId("room-seats-root")).toBeTruthy();
    expect(view.queryByTestId("room-seats-card")).toBeNull();
    const collapsedSeat = view.getByTestId("room-seat-member_1");
    expect(collapsedSeat.textContent).toBe("架");
    expect(collapsedSeat.textContent).not.toContain("claude");

    const toggle = view.getByTestId("room-seats-toggle");
    act(() => {
      toggle.click();
    });

    // Expanded: the floating card carries the labels over the transcript.
    const card = view.getByTestId("room-seats-card");
    expect(card).toBeTruthy();
    expect(card.textContent).toContain("架构师");
    // The rail itself is still there underneath.
    expect(view.getByTestId("room-seat-member_1")).toBeTruthy();
  });

  it("closes the floating card from the backdrop or a second toggle", () => {
    const view = renderSeats(buildRoom());
    const toggle = view.getByTestId("room-seats-toggle");

    act(() => {
      toggle.click();
    });
    expect(view.queryByTestId("room-seats-card")).toBeTruthy();

    act(() => {
      view.getByTestId("room-seats-backdrop").click();
    });
    expect(view.queryByTestId("room-seats-card")).toBeNull();

    act(() => {
      toggle.click();
    });
    expect(view.queryByTestId("room-seats-card")).toBeTruthy();
    act(() => {
      toggle.click();
    });
    expect(view.queryByTestId("room-seats-card")).toBeNull();
  });
});
