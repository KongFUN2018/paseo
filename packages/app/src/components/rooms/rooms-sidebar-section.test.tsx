/** @vitest-environment jsdom */
import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RoomSummary } from "@getpaseo/protocol/room/types";

const roomsRef = { current: [] as RoomSummary[] };

vi.mock("react-native-unistyles", () => {
  const create = (factory: unknown) =>
    typeof factory === "function"
      ? (factory as (theme: unknown) => unknown)({
          spacing: { 1: 4, 2: 8, 3: 12, 6: 24 },
          fontSize: { sm: 12, base: 14 },
          fontWeight: { normal: "400", medium: "500" },
          borderRadius: { lg: 8 },
          colors: { foreground: "#000", foregroundMuted: "#666", border: "#ddd" },
        })
      : factory;
  const StyleSheet = { create };
  // DensityIcon wraps its glyph in withUnistyles; the identity function keeps
  // the mocked component tree renderable.
  const withUnistyles = (component: unknown) => component;
  return {
    StyleSheet,
    useUnistyles: () => ({ theme: {}, rt: { breakpoint: "lg" } }),
    withUnistyles,
  };
});

vi.mock("lucide-react-native", () => ({
  Plus: () => React.createElement("span"),
  ChevronDown: () => React.createElement("span"),
  ChevronRight: () => React.createElement("span"),
}));

vi.mock("@/runtime/host-features", () => ({ useHostFeature: () => true }));

vi.mock("@/stores/navigation-active-workspace-store", () => ({
  navigateToWorkspace: vi.fn(),
  useActiveWorkspaceSelection: () => ({ serverId: "s1", workspaceId: "ws_1" }),
  useLastWorkspaceSelection: () => null,
}));

vi.mock("@/rooms/rooms-query", () => ({
  useRooms: () => ({ rooms: roomsRef.current }),
}));

// The create sheet is irrelevant here and pulls in the whole form graph.
vi.mock("@/components/rooms/room-form-sheet", () => ({
  RoomFormSheet: () => null,
}));

import { RoomsSidebarSection } from "./rooms-sidebar-section";

function room(overrides: Partial<RoomSummary> & { id: string }): RoomSummary {
  return {
    workspaceId: "ws_1",
    name: overrides.id,
    topic: "",
    status: "discussing",
    promptVersion: 2,
    moderator: { agentId: null, provider: "claude", model: null, modeId: null },
    members: [],
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
    lastSeq: 0,
    limits: { maxRounds: 6, maxTurns: 24, turnTimeoutMs: 1000, deltaCharBudget: 1000 },
    artifactPath: "notes/summary.md",
    summary: null,
    createdAt: "2026-11-01T00:00:00.000Z",
    updatedAt: "2026-11-01T00:00:00.000Z",
    closedAt: null,
    closedReason: null,
    ...overrides,
  } as RoomSummary;
}

beforeEach(() => {
  roomsRef.current = [];
});

afterEach(() => {
  cleanup();
});

describe("RoomsSidebarSection archive group", () => {
  it("keeps closed rooms out of the working list and behind a collapsed group", () => {
    roomsRef.current = [room({ id: "live" }), room({ id: "done", status: "closed" })];
    render(<RoomsSidebarSection />);

    // Live room is in the main list; the closed one is not until expanded.
    expect(screen.getByTestId("sidebar-room-live")).toBeTruthy();
    expect(screen.queryByTestId("sidebar-room-done")).toBeNull();

    // Collapsed by default: the archived room is not mounted yet.
    const toggle = screen.getByTestId("sidebar-rooms-archive-toggle");
    expect(screen.queryByTestId("sidebar-room-done")).toBeNull();

    fireEvent.click(toggle);
    expect(screen.getByTestId("sidebar-room-done")).toBeTruthy();
  });

  it("omits the archive group entirely when nothing is closed", () => {
    roomsRef.current = [room({ id: "live" })];
    render(<RoomsSidebarSection />);
    expect(screen.queryByTestId("sidebar-rooms-archive")).toBeNull();
  });
});
