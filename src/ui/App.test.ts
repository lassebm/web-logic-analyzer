// @vitest-environment jsdom
import { render, screen } from "@testing-library/svelte";
import { tick } from "svelte";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { get } from "svelte/store";
import App from "./App.svelte";
import {
  activeTab,
  capabilities,
  captures,
  captureCursor,
  captureStatus,
  connStatus,
  captureBuffer,
  decoders,
  config,
  type CaptureRecord,
} from "../stores/session";
import { FX2_CAPABILITIES } from "../device/fx2";
import { SUMP_DEFAULT_CAPABILITIES } from "../device/sump";
import { CaptureBuffer } from "../model/capture";
import { defaultConfig } from "../test/fixtures";

function record(fill: number, trigger: number | null = null): CaptureRecord {
  const buf = new CaptureBuffer(1_000_000, 64);
  buf.append(new Uint8Array(64).fill(fill));
  return { buffer: buf, atMs: 0, trigger };
}

beforeEach(() => {
  connStatus.set("disconnected");
  captureStatus.set("idle");
  capabilities.set(FX2_CAPABILITIES);
  activeTab.set("analyzer");
  captures.set([]);
  captureCursor.set(0);
  captureBuffer.set(null);
  decoders.set([]);
  config.set(defaultConfig());
});

afterEach(() => {
  activeTab.set("analyzer");
  captures.set([]);
});

describe("Serial Monitor tab", () => {
  it("is offered for a device family that can stream continuously", async () => {
    render(App);
    await tick();
    expect(
      screen.getByRole("button", { name: /Serial Monitor/ }),
    ).toBeInTheDocument();
  });

  // A SUMP device fills its own memory and dumps it, so it can never provide a
  // continuous stream — that's the protocol, not one device. A permanently dead
  // tab is worse than no tab (the Firmware chip is hidden for the same reason).
  it("is hidden for a family that never can", async () => {
    capabilities.set(SUMP_DEFAULT_CAPABILITIES);
    render(App);
    await tick();
    expect(screen.queryByRole("button", { name: /Serial Monitor/ })).toBeNull();
    // The analyzer tab is still there — only the monitor goes.
    expect(
      screen.getByRole("button", { name: /Logic Analyzer/ }),
    ).toBeInTheDocument();
  });

  // Otherwise the tab vanishes while still selected and the page shows nothing.
  it("falls back to the analyzer when it disappears under you", async () => {
    render(App);
    activeTab.set("monitor");
    await tick();

    capabilities.set(SUMP_DEFAULT_CAPABILITIES);
    await tick();

    expect(get(activeTab)).toBe("analyzer");
  });
});

describe("capture pager", () => {
  it("is absent for a single capture", async () => {
    captures.set([record(1)]);
    captureCursor.set(1);
    render(App);
    await tick();
    expect(screen.queryByLabelText("Next capture")).toBeNull();
  });

  it("appears once a run took more than one capture", async () => {
    captures.set([record(1), record(2), record(3)]);
    captureCursor.set(3);
    render(App);
    await tick();

    expect(screen.getByText("3/3")).toBeInTheDocument();
    expect(screen.getByLabelText("Previous capture")).toBeEnabled();
    // Already on the newest, so there is nowhere forward to go.
    expect(screen.getByLabelText("Next capture")).toBeDisabled();
  });

  // Paging swaps which buffer everything else sees, so it must wait until the
  // run is over rather than fighting the live view.
  it("is disabled while a run is still going", async () => {
    captures.set([record(1), record(2)]);
    captureCursor.set(1);
    captureStatus.set("running");
    render(App);
    await tick();
    expect(screen.getByLabelText("Next capture")).toBeDisabled();
    expect(screen.getByLabelText("Previous capture")).toBeDisabled();
  });

  // A fixed count keeps every capture whether or not it triggered, so the pager
  // has to say which one you are looking at — otherwise you page through blind.
  // The marker sits outside the centred readout and keeps its space, so the
  // digits don't jump as you cross a triggered capture.
  it("marks the capture on screen when it met the trigger", async () => {
    captures.set([record(1), record(2, 0), record(3)]);
    captureCursor.set(2);
    render(App);
    await tick();

    const mark = screen.getByTitle("This capture met the trigger condition");
    expect(mark).toBeInTheDocument();
    expect(mark).toHaveClass("on");
    // Not inside the readout, or it would shift the digits.
    expect(mark.parentElement).not.toHaveClass("activity-count");
  });

  it("keeps the marker's space for a capture that did not trigger", async () => {
    captures.set([record(1), record(2, 0), record(3)]);
    captureCursor.set(1);
    render(App);
    await tick();

    const mark = screen.getByTitle("This capture met the trigger condition");
    expect(mark).toBeInTheDocument(); // still laid out...
    expect(mark).not.toHaveClass("on"); // ...just not visible
  });
});
