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
  captureBuffer,
  captureStatus,
  captureTick,
  decoders,
  decodersEnabled,
  view,
  viewportWidth,
} = await import("./session");
const { follow, MAX_LIVE_DECODE_SAMPLES } = await import("./navigation");

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
