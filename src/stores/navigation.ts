// Waveform view navigation — zoom/pan helpers driven by the capture buffer and
// viewport width. Reads/writes the view stores owned by session.ts.
import { derived, get, writable } from "svelte/store";
import {
  captureBuffer,
  captureStatus,
  captureTick,
  config,
  decoders,
  decodersEnabled,
  runAllDecoders,
  view,
  viewFitsWhole,
  viewportWidth,
} from "./session";
import { contentClusters, clusterGapFor } from "../model/clusters";

/** Finest zoom the view allows: 64 pixels per sample. */
const MIN_SPP = 1 / 64;

/**
 * Signal-activity regions of the current capture, for the jump-to-activity nav.
 *
 * The full geometry (exact [start, end] ranges) is only computed once a capture
 * has settled — NOT while it is running. Building it scans the whole transition
 * index (O(sample count)); captureTick bumps on every streamed chunk, so doing it
 * per chunk would be O(n²) over the capture and, on a large one, blocks the main
 * thread long enough to overflow the device FIFO and stall the stream. During a
 * capture the readout instead uses CaptureBuffer's live incremental cluster count
 * (see activityPosition); the precise ranges are only needed for jump-to-activity.
 */
const activityClusters = derived(
  [captureBuffer, captureTick, captureStatus],
  ([$buf, , $status]): Array<[number, number]> =>
    $status !== "running" && $buf && $buf.sampleCount > 0
      ? contentClusters($buf, clusterGapFor($buf.sampleRate))
      : [],
);

/**
 * The selected activity region, 1-based. 0 means "none" (the whole-capture view
 * you land on when a capture stops). jumpToContent steps this cursor: the first
 * forward jump goes to region 1, stepping back before region 1 returns to 0.
 */
export const activityCursor = writable<number>(0);

/**
 * The activity readout as `{ index, total }`, or null when there's no activity.
 * `index` is the selected region (0 = none, the initial post-capture state), so
 * it reflects the jump cursor rather than the viewport.
 *
 * While capturing, the full cluster geometry isn't computed (too costly per
 * chunk), so this reports the live incremental count with the latest region as
 * current — enough for the readout to tick up as activity arrives. The precise
 * regions are resolved once the capture settles.
 */
export const activityPosition = derived(
  [activityClusters, captureBuffer, captureTick, captureStatus, activityCursor],
  ([$clusters, $buf, , $status, $cursor]): {
    index: number;
    total: number;
  } | null => {
    if ($status === "running") {
      const total = $buf?.activityClusterCount() ?? 0;
      return total > 0 ? { index: total, total } : null;
    }
    const total = $clusters.length;
    if (total === 0) return null;
    return { index: Math.min($cursor, total), total };
  },
);

/** Fit the entire capture into the viewport. */
export function zoomToFit(): void {
  const buf = get(captureBuffer);
  const w = get(viewportWidth);
  if (!buf || buf.sampleCount === 0 || w <= 0) return;
  view.set({
    viewStart: 0,
    samplesPerPixel: Math.max(buf.sampleCount / w, MIN_SPP),
  });
  viewFitsWhole.set(true);
}

// A whole-capture ("fit") view has no activity region selected, so its readout
// reads "0/N". Resetting the cursor here — off the shared fit signal — covers
// every path that fits the whole capture in one place: the Fit button
// (zoomToFit), stepping back past the first region, and load/import/finalize
// (fitAndDecode, which sets the flag from session.ts). Otherwise a region number
// selected before a load would linger. Only fires on the false→true edge, and a
// selected region always has the flag false, so a stale cursor is always cleared.
viewFitsWhole.subscribe((fits) => {
  if (fits) activityCursor.set(0);
});

// Re-fit the whole-capture view when the viewport width changes (window resize,
// or a fit computed before the canvas was laid out — e.g. the demo, which fits in
// the same tick it switches tabs, before that tab's canvas has measured itself).
// Only while in fit mode: manual zoom/pan/jump clears the flag and is left alone.
viewportWidth.subscribe(() => {
  if (get(viewFitsWhole)) zoomToFit();
});

/**
 * When on, keep the most recent activity framed while capturing (see followView)
 * rather than letting the whole capture shrink as it grows. When off, the view is
 * pre-sized to the expected capture and stays put as it fills in from the left.
 * Either way, finalizeCapture fits the whole capture once the run ends.
 */
export const follow = writable(true);

// Follow-view tuning: cap a long/continuous run of activity to roughly
// TARGET_EDGES transitions across the viewport so it doesn't zoom out endlessly.
const TARGET_EDGES = 60;

/**
 * Frame the most recent activity while capturing. A completed burst (an idle gap
 * has opened after it — e.g. a UART burst between transmissions) is framed whole
 * with the same zoom/padding as the prev/next-activity jump. A still-ongoing run
 * (no idle gap yet, e.g. a continuous clock) is capped to the most recent detail
 * window (~TARGET_EDGES edges) so it doesn't progressively zoom out as it streams.
 * Anchoring to the latest *edge* rather than the latest *sample* keeps bursty
 * activity on screen through the idle gaps between bursts. Before any activity,
 * it just keeps the current zoom pinned to the newest sample.
 */
export function followView(): void {
  const buf = get(captureBuffer);
  const w = get(viewportWidth);
  if (!buf || w <= 0) return;
  viewFitsWhole.set(false); // following the latest activity, not the whole capture

  const cluster = buf.latestCluster();
  if (!cluster) {
    const spp = get(view).samplesPerPixel;
    const screenful = w * spp;
    view.set({
      viewStart: buf.sampleCount <= screenful ? 0 : buf.sampleCount - screenful,
      samplesPerPixel: spp,
    });
    return;
  }

  const [cStart, cEnd] = cluster;
  // ongoing = still receiving (no idle gap yet) → cap to the detail window; else
  // the burst has completed → frame it whole.
  const ongoing = buf.sampleCount - cEnd <= clusterGapFor(buf.sampleRate);
  const interval = buf.recentEdgeInterval() ?? 1;
  const start = ongoing
    ? Math.max(cStart, cEnd - interval * TARGET_EDGES)
    : cStart;
  fitRange(start, cEnd, w); // same zoom/padding as jumpToContent
}

// Live decoding while following: decode just the samples currently on screen
// (bounded work), throttled with an adaptive interval so a slow decode backs off
// and never starves the capture's USB transfers.
let lastDecodeAt = 0;
let lastDecodeMs = 0;
const MIN_DECODE_INTERVAL_MS = 150;

function liveDecodeInView(): void {
  if (!get(decodersEnabled)) return; // master switch off
  if (!get(decoders).some((d) => d.enabled !== false)) return; // none enabled
  const now = performance.now();
  if (now - lastDecodeAt < Math.max(MIN_DECODE_INTERVAL_MS, lastDecodeMs * 3))
    return;
  const v = get(view);
  const w = get(viewportWidth);
  const start = Math.max(0, Math.floor(v.viewStart));
  const end = Math.ceil(v.viewStart + w * v.samplesPerPixel);
  if (end <= start) return;
  const t0 = performance.now();
  runAllDecoders({ start, end });
  lastDecodeMs = performance.now() - t0;
  lastDecodeAt = now;
}

/**
 * Pre-size a static view to the expected sample count so the growing trace fills
 * the viewport from the left. Used at the start of a capture when Follow is off,
 * so the previous capture's zoom/pan isn't carried over (which is disorienting).
 */
export function resetViewForCapture(): void {
  const w = get(viewportWidth);
  if (w <= 0) return;
  const limit = get(config).sampleLimit;
  view.set({ viewStart: 0, samplesPerPixel: Math.max(limit / w, MIN_SPP) });
  viewFitsWhole.set(false); // pre-sized to the expected limit, not fit to content
}

// Set up the view when a capture starts (roll to the leading edge if following,
// else pre-size a static window), and — while following — keep rolling on every
// streamed chunk. captureTick also bumps once at finalize (status is "done" by
// then, so this stays out of the way and finalizeCapture's own fit wins).
let wasRunning = false;
captureStatus.subscribe(($status) => {
  const running = $status === "running";
  if (running && !wasRunning) {
    // The activity cursor is reset by the viewFitsWhole subscription on finalize.
    if (get(follow)) followView();
    else resetViewForCapture();
  }
  wasRunning = running;
});
captureTick.subscribe(() => {
  if (get(follow) && get(captureStatus) === "running") {
    followView();
    liveDecodeInView();
  }
});

function fitRange(a: number, b: number, w: number): void {
  const total = get(captureBuffer)?.sampleCount ?? b;
  const span = Math.max(b - a, 1);
  const pad = Math.max(span * 0.15, 4);
  // Pad for breathing room, but clamp the padded window to the capture so it
  // never frames negative time or trailing blank — even when the region spans
  // most of the capture (e.g. the demo is one big cluster), where padding would
  // otherwise push the window wider than the whole buffer. The zoom is derived
  // from the clamped width, so the view fits exactly within [0, total].
  const lo = Math.max(a - pad, 0);
  const hi = Math.min(b + pad, total);
  const spp = Math.max((hi - lo) / w, MIN_SPP);
  // A MIN_SPP floor (tiny region, max zoom) can make the on-screen window wider
  // than [lo, hi]; keep its right edge inside the capture.
  const maxStart = Math.max(0, total - w * spp);
  view.set({
    viewStart: Math.min(lo, maxStart),
    samplesPerPixel: spp,
  });
}

/**
 * Step the activity cursor forward/back and zoom to that region. Forward from
 * "none" (0) goes to the first region; stepping back before the first returns to
 * the whole-capture view (cursor 0).
 */
export function jumpToContent(dir: 1 | -1): void {
  const buf = get(captureBuffer);
  const w = get(viewportWidth);
  if (!buf || buf.sampleCount === 0 || w <= 0) return;
  const clusters = get(activityClusters);
  const total = clusters.length;
  if (total === 0) return;

  const cur = get(activityCursor);
  const next = dir > 0 ? Math.min(cur + 1, total) : Math.max(cur - 1, 0);
  if (next === cur) return; // already at an end
  activityCursor.set(next);
  if (next === 0) {
    zoomToFit(); // stepped back past the first region -> whole-capture view
    return;
  }
  viewFitsWhole.set(false); // zoomed to a specific region, not the whole capture
  const [a, b] = clusters[next - 1];
  fitRange(a, b, w);
}
