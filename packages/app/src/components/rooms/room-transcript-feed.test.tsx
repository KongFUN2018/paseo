/** @vitest-environment jsdom */
import React, { forwardRef } from "react";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FlatList, FlatListProps } from "react-native";
import type { RoomRecord, RoomTranscriptEntry } from "@getpaseo/protocol/room/types";
import { applyRoomPartial, clearRoomStreams } from "@/rooms/room-stream-store";
import {
  RoomTranscriptFeed,
  bottomStickOffset,
  type PendingInterjection,
} from "./room-transcript-feed";

// Initializes the real i18n instance (inline en resources) so useTranslation
// resolves strings exactly as the app does.
import { i18n } from "@/i18n/i18next";

interface CapturedFlatListProps {
  data?: readonly { key: string }[];
  onLayout?: (event: { nativeEvent: { layout: { height: number } } }) => void;
  onContentSizeChange?: (width: number, height: number) => void;
  onScroll?: (event: {
    nativeEvent: {
      contentOffset: { y: number };
      contentSize: { height: number };
      layoutMeasurement: { height: number };
    };
  }) => void;
  renderItem?: (info: { item: { key: string } }) => React.ReactElement;
}

interface FlatListSpy {
  props: CapturedFlatListProps;
  scrollToOffset: ReturnType<typeof vi.fn>;
  scrollToEnd: ReturnType<typeof vi.fn>;
}

const flatListSpy: FlatListSpy = {
  props: {},
  scrollToOffset: vi.fn(),
  scrollToEnd: vi.fn(),
};

// The FlatList double records the latest handler props and exposes scroll
// spies through the imperative handle, so tests can drive layout/scroll events
// and assert exact stick offsets without a real virtualizer.
vi.mock("react-native", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-native")>();
  const FlatListDouble = forwardRef<unknown, FlatListProps<unknown>>(
    function FlatListDouble(props, ref) {
      flatListSpy.props = props as unknown as CapturedFlatListProps;
      React.useImperativeHandle(
        ref,
        () =>
          ({
            scrollToOffset: flatListSpy.scrollToOffset,
            scrollToEnd: flatListSpy.scrollToEnd,
          }) as unknown as FlatList<unknown>,
        [],
      );
      const data = (props.data ?? []) as { key: string }[];
      const renderItem = props.renderItem as
        | ((info: { item: { key: string } }) => React.ReactElement)
        | undefined;
      return (
        <div data-testid="room-transcript-feed">
          {renderItem
            ? data.map((rowItem) => (
                <React.Fragment key={rowItem.key}>{renderItem({ item: rowItem })}</React.Fragment>
              ))
            : null}
        </div>
      );
    },
  );
  return { ...actual, FlatList: FlatListDouble as unknown as typeof actual.FlatList };
});

vi.mock("lucide-react-native", () => {
  const icon = (name: string) => {
    const Icon = () => React.createElement("span", { "data-icon": name });
    Icon.displayName = name;
    return Icon;
  };
  return {
    File: icon("File"),
    Database: icon("Database"),
    Image: icon("Image"),
    Table: icon("Table"),
  };
});

vi.mock("react-native-reanimated", () => ({
  default: { View: "div" },
  Easing: { ease: "ease", inOut: (value: unknown) => value },
  useAnimatedStyle: (factory: () => unknown) => factory(),
  useSharedValue: (initial: number) => ({ value: initial }),
  withRepeat: (value: unknown) => value,
  withTiming: (value: unknown) => value,
}));

function entry(seq: number, text: string): RoomTranscriptEntry {
  return {
    seq,
    at: "2026-10-25T08:00:00.000Z",
    kind: "member",
    memberId: "member_1",
    agentId: "agent_1",
    text,
    turnId: null,
  };
}

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
    ],
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
    round: { index: 2, remainingMemberIds: [] },
    transcript: [entry(1, "first statement")],
    interjections: [],
    lastSeq: 1,
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

function renderFeed(
  room: RoomRecord,
  active = true,
  pendingInterjections: readonly PendingInterjection[] = [],
) {
  return render(
    <RoomTranscriptFeed
      room={room}
      serverId="s1"
      truncated={false}
      active={active}
      pendingInterjections={pendingInterjections}
      files={[]}
      onOpenFile={noop}
      onRetryInterjection={noop}
      onDismissInterjection={noop}
    />,
  );
}

function listHandlers(): CapturedFlatListProps {
  const { onLayout, onContentSizeChange, onScroll } = flatListSpy.props;
  if (!onLayout || !onContentSizeChange || !onScroll) {
    throw new Error("FlatList double did not capture handlers");
  }
  return flatListSpy.props;
}

function layoutViewport(height: number) {
  act(() => {
    listHandlers().onLayout!({ nativeEvent: { layout: { height } } });
  });
}

function contentGrowsTo(height: number) {
  act(() => {
    listHandlers().onContentSizeChange!(0, height);
  });
}

function userScrollsTo(offsetY: number, contentHeight: number, viewportHeight: number) {
  act(() => {
    listHandlers().onScroll!({
      nativeEvent: {
        contentOffset: { y: offsetY },
        contentSize: { height: contentHeight },
        layoutMeasurement: { height: viewportHeight },
      },
    });
  });
}

function stream(text: string, done = false) {
  act(() => {
    applyRoomPartial({
      serverId: "s1",
      roomId: "room_ab12",
      memberId: "member_1",
      text,
      toolCalls: 0,
      done,
    });
  });
}

beforeEach(() => {
  flatListSpy.scrollToOffset.mockClear();
  flatListSpy.scrollToEnd.mockClear();
  clearRoomStreams("s1", "room_ab12");
});

// Vitest globals are off in this project, so RTL's auto-cleanup never registers.
afterEach(cleanup);

describe("interjection status captions (§4.6.1, R9 #1)", () => {
  function interjectionRoom(status: "queued" | "delivered" | "answered"): RoomRecord {
    return buildRoom({
      transcript: [
        entry(1, "first statement"),
        {
          seq: 2,
          at: "2026-10-25T08:10:00.000Z",
          kind: "interjection",
          memberId: null,
          agentId: null,
          text: "等等",
          interjectionId: "int_1",
        },
      ],
      interjections: [
        {
          id: "int_1",
          text: "等等",
          createdAt: "2026-10-25T08:10:00.000Z",
          status,
          decidedAt: null,
        },
      ],
      lastSeq: 2,
    });
  }

  it("carries the caption on the transcript interjection row, joined from the daemon status", () => {
    // queued keeps the checkpoint promise; delivered states the moderator
    // checkpoint has presented it once; answered hides the caption — the
    // moderator's reply entry in the feed is the response. Renders unmount
    // between states: RTL keeps every render of one test in the DOM.
    const queued = renderFeed(interjectionRoom("queued"));
    expect(queued.getByTestId("room-transcript-2")).toBeTruthy();
    expect(queued.getByText("Submitted · will be addressed at the next checkpoint")).toBeTruthy();
    queued.unmount();

    const delivered = renderFeed(interjectionRoom("delivered"));
    expect(delivered.getByText("Delivered to the moderator")).toBeTruthy();
    expect(
      delivered.queryByText("Submitted · will be addressed at the next checkpoint"),
    ).toBeNull();
    delivered.unmount();

    const answered = renderFeed(interjectionRoom("answered"));
    expect(answered.queryByText("Delivered to the moderator")).toBeNull();
    expect(answered.queryByText("Submitted · will be addressed at the next checkpoint")).toBeNull();
  });

  it("keeps the fallback caption on the optimistic row while it lives", () => {
    const confirmed: PendingInterjection = {
      localId: "local-1",
      text: "等等",
      state: "confirmed",
      status: "queued",
    };
    const view = renderFeed(buildRoom(), true, [confirmed]);
    expect(view.getByTestId("room-transcript-pending-local-1")).toBeTruthy();
    expect(view.getByText("Submitted · will be addressed at the next checkpoint")).toBeTruthy();
    view.unmount();

    const optimistic: PendingInterjection = {
      localId: "local-3",
      text: "等等",
      state: "pending",
    };
    const inFlight = renderFeed(buildRoom(), true, [optimistic]);
    expect(inFlight.getByText("Submitted · will be addressed at the next checkpoint")).toBeTruthy();
  });
});

describe("bottomStickOffset", () => {
  it("returns null until both heights are measured", () => {
    expect(bottomStickOffset(0, 400)).toBeNull();
    expect(bottomStickOffset(1000, 0)).toBeNull();
    expect(bottomStickOffset(0, 0)).toBeNull();
  });

  it("pins the content end to the viewport bottom and clamps short content", () => {
    expect(bottomStickOffset(1000, 400)).toBe(600);
    expect(bottomStickOffset(300, 400)).toBe(0);
  });
});

describe("RoomTranscriptFeed scroll following (#P1-3)", () => {
  it("jumps to the measured bottom when the list lays out while following", () => {
    renderFeed(buildRoom());
    // Fresh mount keeps the wasAtBottom default (chat opens at the latest).
    layoutViewport(400);
    flatListSpy.scrollToOffset.mockClear();
    contentGrowsTo(1000);
    expect(flatListSpy.scrollToOffset).toHaveBeenCalledWith({ offset: 600, animated: false });
  });

  it("keeps following the streaming row as it grows without a seq change", () => {
    stream("结论");
    renderFeed(buildRoom());
    layoutViewport(400);
    contentGrowsTo(1000);

    // Streaming text grows (no room.lastSeq change): the content-size signal
    // must re-stick to the new exact bottom.
    flatListSpy.scrollToOffset.mockClear();
    stream("结论：可行，理由如下……");
    contentGrowsTo(1200);
    expect(flatListSpy.scrollToOffset).toHaveBeenCalledWith({ offset: 800, animated: false });
  });

  it("stops following when the user scrolls away from the bottom", () => {
    stream("结论");
    renderFeed(buildRoom());
    layoutViewport(400);
    contentGrowsTo(1000);

    // User reads history: far from the bottom (distance 800 > 80).
    userScrollsTo(0, 1000, 400);
    flatListSpy.scrollToOffset.mockClear();

    stream("结论：可行，理由如下……更长的流式文本");
    contentGrowsTo(1400);
    expect(flatListSpy.scrollToOffset).not.toHaveBeenCalled();
  });

  it("resumes following after the user returns to the bottom", () => {
    stream("结论");
    renderFeed(buildRoom());
    layoutViewport(400);
    contentGrowsTo(1000);
    userScrollsTo(0, 1000, 400);
    stream("结论：可行");
    contentGrowsTo(1400);

    // Back at the bottom (distance 0 < 80): growth sticks again.
    userScrollsTo(1000, 1400, 400);
    flatListSpy.scrollToOffset.mockClear();
    stream("结论：可行，且实现简单");
    contentGrowsTo(1600);
    expect(flatListSpy.scrollToOffset).toHaveBeenCalledWith({ offset: 1200, animated: false });
  });

  it("follows a new transcript entry landing while at the bottom", () => {
    stream("结论", true);
    const view = renderFeed(buildRoom());
    layoutViewport(400);
    contentGrowsTo(1000);

    flatListSpy.scrollToOffset.mockClear();
    const grown = buildRoom({
      transcript: [entry(1, "first statement"), entry(2, "second statement")],
      lastSeq: 2,
    });
    act(() => {
      view.rerender(
        <RoomTranscriptFeed
          room={grown}
          serverId="s1"
          truncated={false}
          active
          pendingInterjections={[]}
          files={[]}
          onOpenFile={noop}
          onRetryInterjection={noop}
          onDismissInterjection={noop}
        />,
      );
    });
    contentGrowsTo(1200);
    expect(flatListSpy.scrollToOffset).toHaveBeenCalledWith({ offset: 800, animated: false });
  });

  it("falls back to the list end-scroll before heights are measured", () => {
    stream("结论");
    renderFeed(buildRoom());
    flatListSpy.scrollToEnd.mockClear();
    // A stream change fires before any layout event: no metrics, scrollToEnd.
    stream("结论：可行");
    expect(flatListSpy.scrollToEnd).toHaveBeenCalledWith({ animated: false });
  });

  it("does not follow stream growth while the panel is inactive", () => {
    stream("结论");
    renderFeed(buildRoom(), false);
    layoutViewport(400);
    contentGrowsTo(1000);

    flatListSpy.scrollToOffset.mockClear();
    stream("结论：可行，理由如下");
    contentGrowsTo(1200);
    expect(flatListSpy.scrollToOffset).not.toHaveBeenCalled();
    expect(flatListSpy.scrollToEnd).not.toHaveBeenCalled();
  });

  it("has translations loaded before rendering", () => {
    expect(i18n.isInitialized).toBe(true);
  });
});
