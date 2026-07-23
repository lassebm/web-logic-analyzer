import { beforeEach, describe, expect, it } from "vitest";
import { get } from "svelte/store";
import { CaptureBuffer } from "../model/capture";
import {
  captureBuffer,
  captureStatus,
  captureTick,
  config,
  view,
  viewportWidth,
  viewFitsWhole,
  loadCapture,
  monitorActive,
} from "./session";
import {
  zoomToFit,
  jumpToContent,
  activityPosition,
  activityCursor,
  follow,
  followView,
  resetViewForCapture,
} from "./navigation";

/** Buffer at 1 MHz with two activity clusters (~100 and ~5000), well apart. */
function twoClusterBuffer(): CaptureBuffer {
  const levels = new Uint8Array(5100);
  levels[100] = 1;
  levels[101] = 1; // edges at 100 (rise) and 102 (fall)
  levels[5000] = 1;
  levels[5001] = 1; // edges at 5000 (rise) and 5002 (fall)
  const buf = new CaptureBuffer(1_000_000, levels.length);
  buf.append(levels);
  return buf;
}

beforeEach(() => {
  monitorActive.set(false);
  // Clear fit mode first: the viewportWidth subscription re-fits while it's set.
  viewFitsWhole.set(false);
  viewportWidth.set(1000);
  view.set({ viewStart: 0, samplesPerPixel: 1 });
  captureBuffer.set(null);
  // Reset the capture-driven view state the navigation subscriptions react to.
  captureStatus.set("idle");
  follow.set(true);
  activityCursor.set(0);
});

describe("waveform navigation", () => {
  it("zoomToFit fits the whole capture into the viewport", () => {
    const buf = new CaptureBuffer(1_000_000, 5000);
    buf.append(new Uint8Array(5000));
    captureBuffer.set(buf);
    zoomToFit();
    const v = get(view);
    expect(v.viewStart).toBe(0);
    expect(v.samplesPerPixel).toBeCloseTo(5, 6); // 5000 samples / 1000 px
  });

  it("forward from none (0) jumps to the first activity region", () => {
    captureBuffer.set(twoClusterBuffer());
    jumpToContent(1);
    expect(get(activityCursor)).toBe(1);
    expect(get(view).viewStart).toBeLessThan(200); // first cluster near sample 100
  });

  it("forward again advances to the next region", () => {
    captureBuffer.set(twoClusterBuffer());
    jumpToContent(1);
    jumpToContent(1);
    expect(get(activityCursor)).toBe(2);
    expect(get(view).viewStart).toBeGreaterThan(4000); // second cluster near 5000
  });

  it("forward stops at the last region", () => {
    captureBuffer.set(twoClusterBuffer());
    jumpToContent(1);
    jumpToContent(1);
    jumpToContent(1); // no third region
    expect(get(activityCursor)).toBe(2);
  });

  it("stepping back before the first region returns to the whole view", () => {
    captureBuffer.set(twoClusterBuffer());
    jumpToContent(1); // -> region 1
    jumpToContent(-1); // -> none, whole capture
    expect(get(activityCursor)).toBe(0);
    expect(get(view).viewStart).toBe(0);
    expect(get(view).samplesPerPixel).toBeCloseTo(5100 / 1000, 6); // zoomToFit
  });

  it("does nothing without a capture", () => {
    captureBuffer.set(null);
    view.set({ viewStart: 42, samplesPerPixel: 7 });
    zoomToFit();
    jumpToContent(1);
    expect(get(view)).toEqual({ viewStart: 42, samplesPerPixel: 7 });
    expect(get(activityCursor)).toBe(0);
  });

  it("zoomToFit clears the activity cursor (whole view = no region selected)", () => {
    captureBuffer.set(twoClusterBuffer());
    jumpToContent(1);
    expect(get(activityCursor)).toBe(1);

    zoomToFit(); // the "Fit" button
    expect(get(activityCursor)).toBe(0);
    expect(get(activityPosition)).toEqual({ index: 0, total: 2 }); // reads "0/2"
  });

  it("clamps to t=0 for activity at the very start (no negative time)", () => {
    const levels = new Uint8Array(5100);
    levels[2] = 1;
    levels[3] = 1; // edges at 2 and 4, right against the start
    const buf = new CaptureBuffer(1_000_000, levels.length);
    buf.append(levels);
    captureBuffer.set(buf);

    jumpToContent(1);
    expect(get(view).viewStart).toBe(0); // padded start clamped, never negative
  });

  it("clamps to the last sample for activity at the very end (no trailing blank)", () => {
    const levels = new Uint8Array(5100);
    levels[5090] = 1;
    levels[5091] = 1; // edges at 5090 and 5092, right against the end
    const buf = new CaptureBuffer(1_000_000, levels.length);
    buf.append(levels);
    captureBuffer.set(buf);

    jumpToContent(1);
    const v = get(view);
    const right = v.viewStart + 1000 * v.samplesPerPixel;
    expect(right).toBeLessThanOrEqual(buf.sampleCount + 1e-6); // no space past the end
    expect(v.viewStart).toBeGreaterThan(5000); // still framed on the end activity
  });

  it("frames a region spanning most of the capture without blank past the end", () => {
    // One cluster covering almost the whole capture — like the demo, where every
    // protocol falls into a single activity region. The 15% padding must not push
    // the window wider than the buffer, or blank space frames past the end.
    const levels = new Uint8Array(6512);
    for (let i = 218; i < 6192; i++) levels[i] = Math.floor(i / 50) % 2;
    const buf = new CaptureBuffer(1_000_000, levels.length);
    buf.append(levels);
    captureBuffer.set(buf);

    jumpToContent(1);
    const v = get(view);
    const right = v.viewStart + 1000 * v.samplesPerPixel;
    expect(v.viewStart).toBeGreaterThanOrEqual(0); // no negative time on the left
    expect(right).toBeLessThanOrEqual(buf.sampleCount + 1e-6); // no blank past the end
  });
});

describe("fit follows the viewport width", () => {
  it("re-fits the whole capture when the width changes while fit", () => {
    const buf = new CaptureBuffer(1_000_000, 5000);
    buf.append(new Uint8Array(5000));
    captureBuffer.set(buf);
    zoomToFit(); // fit to width 1000 -> spp 5
    expect(get(view).samplesPerPixel).toBeCloseTo(5, 6);

    // The canvas reports its real (wider) width after the fit — e.g. the demo
    // fits before its tab's canvas has laid out. The fit must self-correct.
    viewportWidth.set(2000);
    expect(get(view).samplesPerPixel).toBeCloseTo(2.5, 6); // 5000 / 2000
    expect(get(view).viewStart).toBe(0);
  });

  it("stops re-fitting once the user zooms to a region", () => {
    captureBuffer.set(twoClusterBuffer());
    zoomToFit();
    jumpToContent(1); // zoom to a region -> leaves fit mode
    const zoomed = get(view);

    viewportWidth.set(2000); // a width change must NOT snap back to the whole view
    expect(get(view)).toEqual(zoomed);
  });

  it("resets the activity cursor when a new capture is loaded (import/demo)", () => {
    captureBuffer.set(twoClusterBuffer());
    jumpToContent(1);
    expect(get(activityCursor)).toBe(1);

    // Loading a file fits the whole capture, which has no region selected — the
    // readout must drop back to "0", not keep the previously selected number.
    const imported = new CaptureBuffer(1_000_000, 4000);
    imported.append(new Uint8Array(4000));
    loadCapture(imported);
    expect(get(activityCursor)).toBe(0);
  });
});

describe("capture-driven view", () => {
  it("followView keeps the zoom and anchors at 0 until a screenful is filled", () => {
    const buf = new CaptureBuffer(1_000_000, 100_000);
    buf.append(new Uint8Array(600)); // 600 < one screenful (1000 px * spp 1)
    captureBuffer.set(buf);
    view.set({ viewStart: 42, samplesPerPixel: 1 });
    followView();
    expect(get(view)).toEqual({ viewStart: 0, samplesPerPixel: 1 });
  });

  it("followView rolls to keep the newest sample at the right edge", () => {
    const buf = new CaptureBuffer(1_000_000, 100_000);
    buf.append(new Uint8Array(30_000));
    captureBuffer.set(buf);
    view.set({ viewStart: 0, samplesPerPixel: 10 }); // screenful = 10,000 samples
    followView();
    // Latest sample (30,000) at the right edge -> start = 30,000 - 10,000.
    expect(get(view)).toEqual({ viewStart: 20_000, samplesPerPixel: 10 });
  });

  it("Follow mode rolls the view on each chunk, preserving the zoom", () => {
    const buf = new CaptureBuffer(1_000_000, 100_000);
    captureBuffer.set(buf);
    view.set({ viewStart: 0, samplesPerPixel: 5 }); // screenful = 5000 samples
    captureStatus.set("running");

    buf.append(new Uint8Array(8000));
    captureTick.update((n) => n + 1);
    expect(get(view)).toEqual({ viewStart: 3000, samplesPerPixel: 5 });

    buf.append(new Uint8Array(2000)); // now 10,000 collected
    captureTick.update((n) => n + 1);
    expect(get(view)).toEqual({ viewStart: 5000, samplesPerPixel: 5 });
  });

  it("followView auto-zooms into a long run of activity and rolls to its edge", () => {
    // Continuous activity: toggle channel 0 every 10 samples (edge spacing 10).
    const data = new Uint8Array(5000);
    for (let i = 0; i < data.length; i++) data[i] = Math.floor(i / 10) % 2;
    const buf = new CaptureBuffer(1_000_000, data.length);
    buf.append(data);
    captureBuffer.set(buf);
    view.set({ viewStart: 0, samplesPerPixel: 100 }); // coarse start zoom

    followView();
    const v = get(view);
    // One big cluster; framed to the recent ~60 edges (span 600) ending at the
    // latest edge (4990), so it zooms in from the coarse start.
    expect(v.samplesPerPixel).toBeLessThan(1);
    const right = v.viewStart + 1000 * v.samplesPerPixel;
    expect(right).toBeGreaterThanOrEqual(4990); // latest edge visible near the right
    expect(v.viewStart).toBeGreaterThan(4000); // showing only the recent detail window
  });

  it("followView frames a completed burst whole, same as the prev/next jump", () => {
    // A long burst (~100 edges, more than the detail-window cap) followed by
    // idle. Follow must frame the WHOLE burst — not just its tail — matching the
    // prev/next-activity jump.
    const data = new Uint8Array(3500);
    for (let i = 200; i < 1200; i++) data[i] = Math.floor((i - 200) / 10) % 2;
    const buf = new CaptureBuffer(1_000_000, data.length);
    buf.append(data);
    captureBuffer.set(buf);

    view.set({ viewStart: 0, samplesPerPixel: 1 });
    followView();
    const followed = get(view);

    view.set({ viewStart: 0, samplesPerPixel: 1 });
    jumpToContent(1); // jump to that (only) activity region
    const jumped = get(view);

    expect(followed.samplesPerPixel).toBeCloseTo(jumped.samplesPerPixel, 6);
    expect(followed.viewStart).toBeCloseTo(jumped.viewStart, 6);
    // The burst starts at ~210; framing the whole burst puts viewStart before it,
    // not inside it.
    expect(followed.viewStart).toBeLessThan(210);
  });

  it("followView frames the latest burst, not the trailing idle or earlier bursts", () => {
    // Two bursts separated by a long idle gap (> clusterGap of 1000), then idle.
    const data = new Uint8Array(4000);
    for (let i = 100; i < 300; i++) data[i] = Math.floor((i - 100) / 10) % 2;
    for (let i = 3000; i < 3200; i++) data[i] = Math.floor((i - 3000) / 10) % 2;
    const buf = new CaptureBuffer(1_000_000, data.length);
    buf.append(data);
    captureBuffer.set(buf);
    view.set({ viewStart: 0, samplesPerPixel: 1 });
    expect(buf.activityClusterCount()).toBe(2);

    followView();
    const v = get(view);
    // Framed on the second burst (~3000–3190), despite the newest sample (3999)
    // being idle and the first burst (~100–290) being long past.
    expect(v.viewStart).toBeGreaterThan(1000); // first burst is off-screen left
    const right = v.viewStart + 1000 * v.samplesPerPixel;
    expect(right).toBeGreaterThanOrEqual(3190); // last edge of the latest burst visible
  });

  it("starting a capture with Follow off pre-sizes a static view to the limit", () => {
    follow.set(false);
    config.update((c) => ({ ...c, sampleLimit: 2_000_000 }));
    view.set({ viewStart: 12345, samplesPerPixel: 0.01 }); // stale zoom
    captureStatus.set("running");
    const v = get(view);
    expect(v.viewStart).toBe(0);
    expect(v.samplesPerPixel).toBeCloseTo(2000, 6); // 2,000,000 / 1000 px
  });

  it("leaves the view alone on new chunks when Follow is off", () => {
    follow.set(false);
    const buf = new CaptureBuffer(1_000_000, 100_000);
    buf.append(new Uint8Array(20_000));
    captureBuffer.set(buf);
    captureStatus.set("running");
    view.set({ viewStart: 5, samplesPerPixel: 7 });

    captureTick.update((n) => n + 1);
    expect(get(view)).toEqual({ viewStart: 5, samplesPerPixel: 7 });
  });

  it("resetViewForCapture pre-sizes the view to the expected sample count", () => {
    config.update((c) => ({ ...c, sampleLimit: 2_000_000 }));
    view.set({ viewStart: 12345, samplesPerPixel: 0.01 });
    resetViewForCapture();
    const v = get(view);
    expect(v.viewStart).toBe(0);
    expect(v.samplesPerPixel).toBeCloseTo(2000, 6);
  });
});

describe("activityPosition", () => {
  it("is null when the capture has no activity", () => {
    const buf = new CaptureBuffer(1_000_000, 5000);
    buf.append(new Uint8Array(5000)); // all idle -> no clusters
    captureBuffer.set(buf);
    expect(get(activityPosition)).toBeNull();
  });

  it("defaults to region 0 (none) and follows the jump cursor", () => {
    captureBuffer.set(twoClusterBuffer());
    expect(get(activityPosition)).toEqual({ index: 0, total: 2 }); // none selected

    jumpToContent(1);
    expect(get(activityPosition)).toEqual({ index: 1, total: 2 });

    jumpToContent(1);
    expect(get(activityPosition)).toEqual({ index: 2, total: 2 });
  });

  it("shows a live incremental count while running, defaults to 0 once settled", () => {
    follow.set(false); // don't let capture-start reposition the view for this check
    captureBuffer.set(twoClusterBuffer()); // 2 clusters

    captureStatus.set("running");
    // Live O(1) count (not the full geometry); latest region marked current.
    expect(get(activityPosition)).toEqual({ index: 2, total: 2 });

    captureStatus.set("done");
    expect(get(activityPosition)).toEqual({ index: 0, total: 2 }); // none selected
  });
});
