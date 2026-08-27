import { beforeEach, describe, expect, it, vi } from "vitest";
import { CaptureBuffer } from "../model/capture";

// Capture the ranges the live pass asks for, without running real decoders.
const ranges: Array<{ start: number; end: number } | undefined> = [];
vi.mock("./session", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./session")>();
  return {
    ...actual,
    runAllDecoders: (r?: { start: number; end: number }) => ranges.push(r),
  };
});

const {
  capabilities,
  captureBuffer,
  captureStatus,
  captureTick,
  decoders,
  decodersEnabled,
  view,
  viewportWidth,
} = await import("./session");
const { follow, MAX_LIVE_DECODE_SAMPLES } = await import("./navigation");
const { FX2_CAPABILITIES } = await import("../device/fx2");
const { SUMP_DEFAULT_CAPABILITIES } = await import("../device/sump");

beforeEach(() => {
  ranges.length = 0;
  decodersEnabled.set(true);
  decoders.set([
    {
      uid: "d1",
      decoderId: "uart",
      label: "UART 1",
      channelMap: [0],
      options: {},
      annotations: [],
      enabled: true,
    },
  ]);
  viewportWidth.set(1000);
  follow.set(true);
  capabilities.set(FX2_CAPABILITIES);
});

describe("live in-view decode budget", () => {
  it("decodes at most MAX_LIVE_DECODE_SAMPLES, keeping the newest slice", () => {
    const n = MAX_LIVE_DECODE_SAMPLES * 2;
    const buf = new CaptureBuffer(1_000_000, n);
    buf.append(new Uint8Array(n));
    captureBuffer.set(buf);
    // A whole-capture-wide view, as followView leaves after framing a long
    // completed burst: the raw window is twice the budget.
    view.set({ viewStart: 0, samplesPerPixel: n / 1000 });
    captureStatus.set("running");

    captureTick.update((t) => t + 1);

    const last = ranges.at(-1);
    expect(last).toBeDefined();
    expect(last!.end - last!.start).toBe(MAX_LIVE_DECODE_SAMPLES);
    expect(last!.end).toBe(n); // clamped to the newest samples, not the oldest
    captureStatus.set("idle");
  });
});

describe("following a device that cannot stream", () => {
  // `follow` outlives a device change, so a user who had it on with an FX2 and
  // then connected a one-shot device would still trigger a live pass — one full
  // windowed decode per capture, which is the O(capture) work the capture pager
  // exists to defer. The toolbar hides the toggle; this is the behaviour half.
  it("runs no live decode, however the toggle was left", async () => {
    const buf = new CaptureBuffer(1_000_000, 1000);
    buf.append(new Uint8Array(1000));
    captureBuffer.set(buf);
    view.set({ viewStart: 0, samplesPerPixel: 1 });
    follow.set(true);
    captureStatus.set("running");

    // liveDecodeInView() throttles on module state shared with the other tests
    // here, so wait it out — otherwise the assertion below passes because of the
    // throttle rather than because of the gate.
    await new Promise((r) => setTimeout(r, 200));

    // Control: the very same window *does* decode for a streaming device.
    capabilities.set(FX2_CAPABILITIES);
    captureTick.update((t) => t + 1);
    expect(ranges).toHaveLength(1);

    await new Promise((r) => setTimeout(r, 200));

    capabilities.set(SUMP_DEFAULT_CAPABILITIES);
    captureTick.update((t) => t + 1);
    expect(ranges).toHaveLength(1); // nothing new: the gate, not the throttle

    captureStatus.set("idle");
  });
});
