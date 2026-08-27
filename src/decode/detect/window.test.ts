import { describe, expect, it } from "vitest";
import { CaptureBuffer } from "../../model/capture";
import { MAX_SCAN_EDGES, SCAN_ATTEMPTS, scanWindows } from "./window";

const SR = 1_000_000;

/** A buffer whose channel `ch` toggles every sample for `edges` samples, after
 *  `idle` samples of silence. Other channels stay low. */
function toggling(edges: number, ch = 0, idle = 0): CaptureBuffer {
  const buf = new CaptureBuffer(SR, idle + edges);
  const data = new Uint8Array(idle + edges);
  for (let i = 0; i < edges; i++) data[idle + i] = (i & 1) << ch;
  buf.append(data);
  return buf;
}

describe("scanWindows", () => {
  it("offers nothing for a channel that never changes", () => {
    const flat = new CaptureBuffer(SR, 64);
    flat.append(new Uint8Array(64).fill(0b1));
    expect(scanWindows(flat, [0])).toEqual([]);
  });

  it("offers nothing for an empty capture", () => {
    expect(scanWindows(new CaptureBuffer(SR, 0), [0])).toEqual([]);
  });

  it("covers everything from the first edge when the capture is small", () => {
    const buf = toggling(200, 0, 50);
    const windows = scanWindows(buf, [0]);
    expect(windows).toHaveLength(1);
    // Anchored at the first edge, not at sample 0 — the idle prefix is skipped.
    expect(windows[0].start).toBe(51);
    expect(windows[0].end).toBe(buf.sampleCount);
  });

  it("anchors at the channel's own first edge, not another channel's", () => {
    // Channel 1 chatters from the start; channel 0 only much later.
    const buf = new CaptureBuffer(SR, 400);
    const data = new Uint8Array(400);
    for (let i = 0; i < 400; i++) {
      data[i] = (i & 1) << 1; // ch1 toggling throughout
      if (i >= 300) data[i] |= (i & 1) << 0; // ch0 only from 300
    }
    buf.append(data);
    expect(scanWindows(buf, [0])[0].start).toBe(301);
    expect(scanWindows(buf, [1])[0].start).toBe(1);
  });

  it("spreads several bounded windows over a long capture", () => {
    const buf = toggling(MAX_SCAN_EDGES * 4);
    const windows = scanWindows(buf, [0]);
    expect(windows).toHaveLength(SCAN_ATTEMPTS);

    // Each is bounded, and they advance across the capture.
    for (const w of windows) {
      expect(buf.transitionsIn(w.start, w.end).length).toBeLessThanOrEqual(
        MAX_SCAN_EDGES + 1,
      );
    }
    for (let i = 1; i < windows.length; i++) {
      expect(windows[i].start).toBeGreaterThan(windows[i - 1].start);
    }
    // The last one reaches the end, so a signal that only appears there is
    // still inside a window.
    expect(windows[windows.length - 1].end).toBe(buf.sampleCount);
  });
});
