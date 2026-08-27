/**
 * How much of a capture a scan looks at.
 *
 * Detection is expensive in a way the rest of the app is not: identifying a UART
 * means trial-decoding it once per candidate framing (baud × data bits × parity ×
 * inversion), and an I²C bus means scoring every channel pair in both
 * orientations. On eight active channels that is hundreds of full decoder passes,
 * so scanning the whole buffer made cost scale with capture length and froze the
 * tab on anything large.
 *
 * Nothing about identification needs the whole buffer, though: the detectors are
 * satisfied by a handful of frames (`MIN_FRAMES`, `MIN_BYTES`). So each scan runs
 * over a *window* of bounded edge count instead, and cost stops depending on how
 * long the capture is.
 *
 * Two things keep that from becoming "only look at the beginning":
 *
 *  - A window is anchored where the channels in question first have an edge, not
 *    at sample 0. A line that stays idle for the first nine tenths of a capture
 *    is scanned where it actually talks.
 *  - More than one window is offered, spread from that first edge to the end of
 *    the capture, and a detector tries the next one when a window yields nothing.
 *    A channel that carries a glitch early and a real signal much later is still
 *    found.
 *
 * What remains best-effort: a signal that only appears somewhere none of the
 * windows land is missed, where a full scan would have found it. That is the
 * trade for a bounded, interruptible scan, and Detect is a convenience — a
 * decoder can always be added by hand.
 */
import type { CaptureBuffer } from "../../model/capture";

/**
 * Edges one window may span.
 *
 * Measured on the demo capture repeated to 130k and 651k samples, all eight
 * channels active, scanning every pair and channel:
 *
 *   budget   130k     651k    hits
 *     4096   3474 ms  3441 ms    6
 *     1024    389 ms   329 ms    6
 *      512    135 ms   116 ms    6   <- here
 *      256     67 ms    53 ms    5   <- starts missing signals
 *
 * Two things to read off that. Cost is flat in capture length, which is the
 * whole point — the same scan over the whole buffer took 3 s at 130k samples and
 * 61 s at 651k, i.e. linear, and hours on a 100M-sample capture. And 512 is the
 * smallest budget that still finds everything the unbounded scan did, with 256
 * dropping a hit: a window of 512 edges is ~50 UART frames or ~25 I²C bytes
 * against thresholds of 4 frames / 2 bytes / 8 clock phases, so the headroom is
 * real but not unlimited. Don't shrink this without re-measuring the hit column.
 */
export const MAX_SCAN_EDGES = 512;

/** Windows offered per scan, from first activity to the end of the capture. */
export const SCAN_ATTEMPTS = 3;

export interface ScanWindow {
  start: number;
  end: number;
}

/** Index of the first transition at which any of `channels` changes value. */
function firstEdgeIndex(
  buf: CaptureBuffer,
  transitions: Uint32Array,
  channels: number[],
): number {
  for (let k = 0; k < transitions.length; k++) {
    const i = transitions[k];
    for (const ch of channels) {
      if (buf.channelValueAt(ch, i) !== buf.channelValueAt(ch, i - 1)) return k;
    }
  }
  return -1;
}

/**
 * Windows to try when scanning `channels`, in the order to try them: the first
 * sits at their first edge, the last at the end of the capture.
 *
 * Empty when none of the channels ever change — a static line, which every
 * detector rejects anyway. A single window covering everything from the first
 * edge on when the capture is small enough to scan whole.
 */
export function scanWindows(
  buf: CaptureBuffer,
  channels: number[],
): ScanWindow[] {
  if (buf.sampleCount === 0) return [];
  const transitions = buf.transitions();
  const first = firstEdgeIndex(buf, transitions, channels);
  if (first < 0) return [];

  const available = transitions.length - first;
  if (available <= MAX_SCAN_EDGES) {
    return [{ start: transitions[first], end: buf.sampleCount }];
  }

  // Spread the attempts over the edges from the first one to the last, so the
  // windows are "where it starts", "somewhere in the middle" and "at the end".
  const span = available - MAX_SCAN_EDGES;
  const out: ScanWindow[] = [];
  for (let k = 0; k < SCAN_ATTEMPTS; k++) {
    const at = first + Math.floor((span * k) / (SCAN_ATTEMPTS - 1));
    const end = at + MAX_SCAN_EDGES;
    out.push({
      start: transitions[at],
      end: end < transitions.length ? transitions[end] : buf.sampleCount,
    });
  }
  return out;
}
