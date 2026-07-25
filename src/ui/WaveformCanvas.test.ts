// @vitest-environment jsdom
import { render, screen, fireEvent } from "@testing-library/svelte";
import { tick } from "svelte";
import { get } from "svelte/store";
import { beforeEach, describe, expect, it } from "vitest";
import WaveformCanvas from "./WaveformCanvas.svelte";
import {
  decoders,
  captureBuffer,
  config,
  view,
  cursors,
} from "../stores/session";
import { CaptureBuffer } from "../model/capture";
import { defaultConfig } from "../test/fixtures";

/** A trivial buffer so onWheel treats the canvas as having a capture. */
function idleBuffer(): CaptureBuffer {
  const buf = new CaptureBuffer(1_000_000, 1000);
  buf.append(new Uint8Array(1000));
  return buf;
}

beforeEach(() => {
  // No buffer => the canvas draw is skipped (jsdom has no real 2D context),
  // so only the gutter lane labels are exercised here.
  captureBuffer.set(null);
  decoders.set([]);
  config.set(defaultConfig());
});

describe("WaveformCanvas", () => {
  it("labels decoder lanes with the per-instance label plus the annotation-row name", async () => {
    decoders.set([
      {
        uid: "d1",
        decoderId: "uart",
        label: "UART 1",
        channelMap: [0],
        options: {},
        annotations: [],
      },
      {
        uid: "d2",
        decoderId: "uart",
        label: "RX bus",
        channelMap: [1],
        options: {},
        annotations: [],
      },
    ]);
    render(WaveformCanvas);
    await tick();

    // UART exposes Bits / Data / Errors annotation rows; the gutter label is
    // "<instance label>:<row name>" so two instances stay distinguishable.
    expect(screen.getByText("UART 1:Bits")).toBeInTheDocument();
    expect(screen.getByText("UART 1:Data")).toBeInTheDocument();
    expect(screen.getByText("UART 1:Errors")).toBeInTheDocument();
    expect(screen.getByText("RX bus:Bits")).toBeInTheDocument();
    expect(screen.getByText("RX bus:Data")).toBeInTheDocument();
    expect(screen.getByText("RX bus:Errors")).toBeInTheDocument();
  });

  it("shows channel labels for enabled channels", async () => {
    render(WaveformCanvas);
    await tick();
    expect(screen.getByText("D0")).toBeInTheDocument();
    expect(screen.getByText("D7")).toBeInTheDocument();
  });

  it("hides the label of a disabled channel", async () => {
    config.set(
      defaultConfig({
        enabledChannels: [false, true, true, true, true, true, true, true],
      }),
    );
    render(WaveformCanvas);
    await tick();
    expect(screen.queryByText("D0")).not.toBeInTheDocument();
    expect(screen.getByText("D1")).toBeInTheDocument();
  });

  it("drops the lanes of a decoder whose channel is hidden", async () => {
    decoders.set([
      {
        uid: "d1",
        decoderId: "uart",
        label: "UART 1",
        channelMap: [0],
        options: {},
        annotations: [],
      },
      {
        uid: "d2",
        decoderId: "uart",
        label: "RX bus",
        channelMap: [1],
        options: {},
        annotations: [],
      },
    ]);
    config.set(
      defaultConfig({
        enabledChannels: [false, true, true, true, true, true, true, true],
      }),
    );
    render(WaveformCanvas);
    await tick();

    // D0 is hidden, so the decoder reading it loses its lanes; the D1 one stays.
    expect(screen.queryByText("UART 1:Data")).not.toBeInTheDocument();
    expect(screen.getByText("RX bus:Data")).toBeInTheDocument();
  });

  // placeCursor and its two-cursor ring had no coverage: Measurements.test.ts
  // sets `cursors` directly, so click-to-measure was never exercised.
  it("places measurement cursors on click and cycles the pair", async () => {
    // jsdom has no pointer capture; the handler calls it unconditionally.
    (
      Element.prototype as unknown as Record<string, unknown>
    ).setPointerCapture ??= () => {};
    captureBuffer.set(idleBuffer());
    cursors.set([]);
    view.set({ viewStart: 0, samplesPerPixel: 1 });
    const { container } = render(WaveformCanvas);
    await tick();
    const canvas = container.querySelector("canvas")!;

    // A rect of zeros in jsdom means clientX maps straight to the sample index.
    const click = async (x: number) => {
      await fireEvent.pointerDown(canvas, { clientX: x, pointerId: 1 });
      await fireEvent.pointerUp(canvas, { clientX: x, pointerId: 1 });
    };

    await click(10);
    expect(get(cursors)).toEqual([10]);
    await click(20);
    expect(get(cursors)).toEqual([10, 20]);
    // Third click replaces the oldest, so the pair keeps moving.
    await click(30);
    expect(get(cursors)).toEqual([30, 20]);
    await click(40);
    expect(get(cursors)).toEqual([30, 40]);
  });

  it("pans on a horizontal (two-finger) wheel with no modifier", async () => {
    captureBuffer.set(idleBuffer());
    view.set({ viewStart: 0, samplesPerPixel: 2 });
    const { container } = render(WaveformCanvas);
    await tick();
    const canvas = container.querySelector("canvas")!;
    await fireEvent.wheel(canvas, { deltaX: 100, deltaY: 0 });
    expect(get(view).viewStart).toBeCloseTo(200, 6); // 0 + 100 * spp(2)
  });

  it("leaves a plain vertical wheel for native scrolling (no pan)", async () => {
    captureBuffer.set(idleBuffer());
    view.set({ viewStart: 50, samplesPerPixel: 2 });
    const { container } = render(WaveformCanvas);
    await tick();
    const canvas = container.querySelector("canvas")!;
    await fireEvent.wheel(canvas, { deltaX: 0, deltaY: 120 });
    expect(get(view).viewStart).toBe(50); // unchanged
  });
});
