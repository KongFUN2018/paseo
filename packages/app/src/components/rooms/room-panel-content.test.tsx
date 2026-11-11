/** @vitest-environment jsdom */
import React from "react";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RoomRecord } from "@getpaseo/protocol/room/types";
import { applyRoomPartial, clearRoomStreams } from "@/rooms/room-stream-store";
import { commitRoomUpdates, useRoomsStore } from "@/rooms/rooms-store";
// Initializes the real i18n instance (inline en resources) so useTranslation
// resolves strings exactly as the app does.
import { i18n } from "@/i18n/i18next";
// Vitest hoists every vi.mock above the imports, so the component under test
// resolves against the mocked module graph below.
import { RoomPanelContent } from "./room-panel-content";

vi.mock("react-native-reanimated", () => ({
  default: { View: "div", ScrollView: "div" },
  Easing: { ease: "ease", inOut: (value: unknown) => value },
  useAnimatedStyle: (factory: () => unknown) => factory(),
  useSharedValue: (initial: number) => ({ value: initial }),
  withRepeat: (value: unknown) => value,
  withTiming: (value: unknown) => value,
  useAnimatedScrollHandler: () => () => {},
}));

vi.mock("react-native-keyboard-controller", () => ({
  KeyboardAvoidingView: ({ children }: { children?: React.ReactNode }) => children,
}));

vi.mock("lucide-react-native", () => {
  const icon = (name: string) => {
    const Icon = () => React.createElement("span", { "data-icon": name });
    Icon.displayName = name;
    return Icon;
  };
  return {
    // Room panel + header + alert icons; none render anything assertion-relevant.
    Paperclip: icon("Paperclip"),
    Archive: icon("Archive"),
    Flag: icon("Flag"),
    Loader: icon("Loader"),
    MessageCircle: icon("MessageCircle"),
    PauseCircle: icon("PauseCircle"),
    PlayCircle: icon("PlayCircle"),
    AlertTriangle: icon("AlertTriangle"),
    CheckCircle2: icon("CheckCircle2"),
    Info: icon("Info"),
    XCircle: icon("XCircle"),
    File: icon("File"),
    Database: icon("Database"),
    Image: icon("Image"),
    Table: icon("Table"),
  };
});

vi.mock("@/runtime/host-runtime", () => ({
  useHostRuntimeClient: () => null,
  useHostRuntimeIsConnected: () => true,
}));

vi.mock("@/rooms/rooms-query", () => ({
  useRoomQuery: () => ({
    isPending: false,
    error: null,
    isSuccess: true,
    // The rooms store snapshot is the render source; the query result only
    // feeds the empty-room branch, which these tests do not exercise.
    data: { room: null, truncated: false },
    refetch: vi.fn(),
  }),
  useRoomFilesQuery: () => ({ data: [], refetch: vi.fn() }),
}));

vi.mock("@/rooms/use-room-actions", () => ({
  useRoomActions: () => ({
    startRoom: vi.fn(),
    pauseRoom: vi.fn(),
    resumeRoom: vi.fn(),
    interject: vi.fn(),
    closeRoom: vi.fn(),
    reopenRoom: vi.fn(),
    pendingAction: null,
    actionError: null,
    dismissActionError: vi.fn(),
  }),
}));

vi.mock("@/utils/confirm-dialog", () => ({
  confirmDialog: vi.fn().mockResolvedValue(false),
}));

vi.mock("@/components/rooms/room-notice-region", () => ({
  RoomFailureCard: () => null,
  RoomReconnectAlert: () => null,
  RoomPermissionCard: () => null,
}));

vi.mock("@/components/rooms/room-interjection-composer", () => ({
  RoomInterjectionComposer: React.forwardRef(function RoomInterjectionComposer() {
    return <div data-testid="room-interjection-composer" />;
  }),
}));

vi.mock("@/components/rooms/room-files-drawer", () => ({
  RoomFilesDrawer: () => null,
}));

vi.mock("@/components/rooms/room-member-add-sheet", () => ({
  RoomMemberAddSheet: () => null,
}));

function buildRoom(overrides: Partial<RoomRecord> = {}): RoomRecord {
  return {
    id: "room_ab12",
    workspaceId: "ws_1",
    name: "补测圆桌",
    topic: "Pick a message queue",
    status: "interrupted",
    promptVersion: 2,
    moderator: { agentId: "mod_agent", provider: "claude", model: "mock", modeId: null },
    members: [
      {
        id: "member_1",
        agentId: "agent_1",
        provider: "mock",
        model: "one-minute-stream",
        modeId: null,
        persona: "",
        status: "ready",
        joinedAt: "2026-10-24T10:00:00.000Z",
        lastDeliveredSeq: 3,
        turnCount: 2,
        displayName: "架构师",
      },
    ],
    // The pause step keeps an in-flight turn as it was (scheduler user_pause
    // only flips status); the panel must cope with a live-shaped turn.
    turn: {
      index: 3,
      memberId: "member_1",
      agentId: "agent_1",
      turnId: null,
      status: "speaking",
      startedAt: "2026-10-25T08:20:00.000Z",
      deadlineAt: null,
      attempt: 0,
    },
    round: { index: 4, remainingMemberIds: [] },
    transcript: [
      {
        seq: 1,
        at: "2026-10-25T08:00:00.000Z",
        kind: "member",
        memberId: "member_1",
        agentId: "agent_1",
        text: "first statement",
        turnId: null,
      },
    ],
    interjections: [],
    lastSeq: 1,
    limits: { maxRounds: 12, maxTurns: 50, turnTimeoutMs: 900000, deltaCharBudget: 24000 },
    artifactPath: ".paseo/rooms/room/summary.md",
    summary: null,
    createdAt: "2026-10-24T10:00:00.000Z",
    updatedAt: "2026-10-25T08:23:19.000Z",
    closedAt: null,
    closedReason: null,
    ...overrides,
  };
}

function seedRoom(room: RoomRecord) {
  act(() => {
    commitRoomUpdates([{ serverId: "s1", roomId: room.id, entry: { room, truncated: false } }]);
  });
}

function renderPanel(room: RoomRecord) {
  return render(
    <RoomPanelContent serverId="s1" roomId={room.id} onOpenAgent={noop} onOpenFile={noop} />,
  );
}

beforeEach(() => {
  clearRoomStreams("s1", "room_ab12");
  useRoomsStore.setState({ roomsByServerId: {} });
});

// Vitest globals are off in this project, so RTL's auto-cleanup never registers.
afterEach(cleanup);

const noop = () => {};

describe("RoomPanelContent interrupted state (#P0-1)", () => {
  it("has translations loaded before rendering", () => {
    expect(i18n.isInitialized).toBe(true);
  });

  it("renders the interrupted card and the resume action after a pause", () => {
    seedRoom(buildRoom());
    renderPanel(buildRoom());

    expect(screen.getByTestId("room-panel-content")).toBeTruthy();
    expect(screen.getByTestId("room-interrupted-card")).toBeTruthy();
    expect(screen.getByTestId("room-resume")).toBeTruthy();
    expect(screen.getByTestId("room-close-from-interrupted")).toBeTruthy();
    // The header carries no pause action once interrupted.
    expect(screen.queryByTestId("room-pause")).toBeNull();
    // The seatline states the interrupted fact.
    expect(screen.getByTestId("room-seatline").textContent).toContain(
      i18n.t("rooms.panel.interruptedNoSpend"),
    );
  });

  it("keeps rendering the interrupted card while a paused speaker's partial stream lingers", () => {
    seedRoom(buildRoom());
    act(() => {
      applyRoomPartial({
        serverId: "s1",
        roomId: "room_ab12",
        memberId: "member_1",
        text: "被暂停时正在流式输出的半句话",
        toolCalls: 1,
        done: false,
      });
    });
    renderPanel(buildRoom());

    // The live streaming row is still part of the feed (turn stayed speaking).
    expect(screen.getByTestId("room-transcript-streaming")).toBeTruthy();
    // And the interrupted card with its resume action is present regardless.
    expect(screen.getByTestId("room-interrupted-card")).toBeTruthy();
    expect(screen.getByTestId("room-resume")).toBeTruthy();
  });

  it("keeps an idle-turn interrupted room on the card branch too", () => {
    const idleTurn = buildRoom({
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
    });
    seedRoom(idleTurn);
    renderPanel(idleTurn);

    expect(screen.getByTestId("room-interrupted-card")).toBeTruthy();
    expect(screen.getByTestId("room-resume")).toBeTruthy();
    expect(screen.queryByTestId("room-transcript-streaming")).toBeNull();
  });

  it("does not show the interrupted card while discussing", () => {
    const discussing = buildRoom({ status: "discussing" });
    seedRoom(discussing);
    renderPanel(discussing);

    expect(screen.queryByTestId("room-interrupted-card")).toBeNull();
    expect(screen.getByTestId("room-pause")).toBeTruthy();
  });
});
