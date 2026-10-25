/** @vitest-environment jsdom */
import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
// Initializes the real i18n instance (inline en resources) so the fallback
// resolves the same strings the app shows. Vitest hoists every vi.mock above
// the imports, so the boundary under test resolves against the mocked graph.
import { i18n } from "@/i18n/i18next";
import { RoomPanelErrorBoundary } from "./room-panel";

vi.mock("react-native-reanimated", () => {
  // Menu/button surfaces pull module-scope animation primitives (Keyframe
  // presets); dummies satisfy construction without the native runtime.
  const preset = { duration: 0 };
  class Keyframe {
    duration() {
      return this;
    }
  }
  return {
    default: { View: "div" },
    Easing: { ease: "ease", inOut: (value: unknown) => value },
    Keyframe,
    FadeIn: preset,
    FadeOut: preset,
    FadeInUp: preset,
    FadeOutUp: preset,
    SlideInDown: preset,
    SlideOutDown: preset,
    LinearTransition: preset,
    useAnimatedStyle: (factory: () => unknown) => factory(),
    useSharedValue: (initial: number) => ({ value: initial }),
    withRepeat: (value: unknown) => value,
    withTiming: (value: unknown) => value,
  };
});

// The full content tree (composer, sheets, keyboard controller) has its own
// test; here it is a stub so the boundary stays the unit under test.
vi.mock("@/components/rooms/room-panel-content", () => ({
  RoomPanelContent: () => <div data-testid="room-panel-content-stub" />,
}));

/**
 * Throws while `flakyFails` is set. React 18 dev retries a failed render
 * pass, so a render-counting child would self-heal; the flag only flips when
 * the test acts like the user fixing the condition and pressing retry.
 */
let flakyFails = true;
function FlakyChild({ id }: { id: string }) {
  if (flakyFails) {
    throw new Error(`boom ${id}`);
  }
  return <div data-testid="recovered-child">{id}</div>;
}

function AlwaysThrows(): never {
  throw new Error("permanent failure");
}

// Vitest globals are off in this project, so RTL's auto-cleanup never registers.
afterEach(cleanup);

describe("RoomPanelErrorBoundary (#P0-1)", () => {
  it("renders children when nothing throws", () => {
    render(
      <RoomPanelErrorBoundary>
        <div data-testid="healthy-child" />
      </RoomPanelErrorBoundary>,
    );
    expect(screen.getByTestId("healthy-child")).toBeTruthy();
    expect(screen.queryByTestId("room-panel-error-boundary")).toBeNull();
  });

  it("contains a child render error inside the panel with an in-place retry", () => {
    flakyFails = true;
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    render(
      <RoomPanelErrorBoundary>
        <FlakyChild id="first" />
      </RoomPanelErrorBoundary>,
    );

    // The app outside the panel keeps running; the panel itself shows the
    // error card instead of blanking (the #P0-1 symptom).
    expect(screen.getByTestId("room-panel-error-boundary")).toBeTruthy();
    expect(screen.getByTestId("room-panel-retry")).toBeTruthy();
    expect(screen.getByTestId("room-panel-error-boundary").textContent).toContain("boom first");
    expect(screen.queryByTestId("recovered-child")).toBeNull();
    consoleError.mockRestore();
  });

  it("remounts the panel content after retry and recovers", () => {
    flakyFails = true;
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    render(
      <RoomPanelErrorBoundary>
        <FlakyChild id="second" />
      </RoomPanelErrorBoundary>,
    );
    expect(screen.getByTestId("room-panel-error-boundary")).toBeTruthy();

    // The failing condition clears (e.g. transient snapshot state), then the
    // user presses retry: the remounted content renders against the store.
    flakyFails = false;
    fireEvent.click(screen.getByTestId("room-panel-retry"));

    expect(screen.getByTestId("recovered-child").textContent).toBe("second");
    expect(screen.queryByTestId("room-panel-error-boundary")).toBeNull();
    consoleError.mockRestore();
  });

  it("stays contained across repeated failures", () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    render(
      <RoomPanelErrorBoundary>
        <AlwaysThrows />
      </RoomPanelErrorBoundary>,
    );
    expect(screen.getByTestId("room-panel-error-boundary")).toBeTruthy();
    expect(screen.getByTestId("room-panel-error-boundary").textContent).toContain("permanent");
    // Retry against a persistently failing child keeps the fallback, and the
    // boundary never propagates the error upward.
    fireEvent.click(screen.getByTestId("room-panel-retry"));
    expect(screen.getByTestId("room-panel-error-boundary")).toBeTruthy();
    consoleError.mockRestore();
  });

  it("resolves fallback strings through the shared i18n instance", () => {
    expect(i18n.isInitialized).toBe(true);
    expect(i18n.t("rooms.panel.retry")).toBe("Retry");
  });
});
