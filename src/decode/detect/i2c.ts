/**
 * I²C auto-detection over a channel pair. Unlike UART, I²C is self-clocked, so
 * there is no rate to search — the work is deciding, for a candidate `(SCL, SDA)`
 * pair, whether the two lines behave like an I²C bus and which is which.
 *
 * The defining invariant does both jobs: **SDA is stable while SCL is high**
 * (data is valid only during the clock-high window; the only SDA edges allowed
 * there are START/STOP). So we score the fraction of SCL-high phases in which SDA
 * held steady. For the true clock this is ~1; for the swapped roles — or a random
 * pair — the "clock" line toggles freely during the other line's high phases, and
 * the score collapses. A trial decode with the real I²C decoder then confirms the
 * pair actually frames into addressed bytes.
 *
 * Callers pass a fixed orientation; {@link ./index} tries both `(a,b)` and
 * `(b,a)` and keeps the better one. Pure and dependency-free like the decoders.
 */
import type { CaptureBuffer } from "../../model/capture";
import { runDecoder } from "../engine";
import { i2cDecoder } from "../decoders/i2c";
import type { I2cDetection } from "./types";

/** The i2c decoder's annotation classes (see decoders/i2c.ts). */
const ANN_START = 0;
const ANN_STOP = 1;
const ANN_ADDR = 2;
const ANN_DATA = 3;

/** A clock this short isn't a bus — need a few cycles to judge stability. */
const MIN_HIGH_PHASES = 8;
/** Require at least one addressed transaction's worth of bytes (address + data). */
const MIN_BYTES = 2;
/** Minimum SDA-steady-during-SCL-high ratio to accept the pair as I²C. */
const MIN_STABILITY = 0.8;
/**
 * Maximum share of SDA edges allowed to fall while SCL is high. On a real bus
 * only START/STOP move SDA during SCL-high, so this is tiny; an unrelated data
 * line paired with a mostly-high "clock" trips it well past this bound.
 */
const MAX_HIGH_EDGE_RATIO = 0.25;

interface PairShape {
  /** Fraction of SCL-high phases during which SDA held steady, in [0, 1]. */
  stability: number;
  /** Total number of complete SCL-high phases observed. */
  highPhases: number;
  /** Fraction of SDA edges that occurred while SCL was high, in [0, 1]. */
  highEdgeRatio: number;
}

/**
 * Characterise a candidate `(scl, sda)` pair in a single O(edges) pass:
 *
 * - **stability** — fraction of SCL-high phases in which SDA stayed put. Catches
 *   the swapped orientation, where the "clock" toggles all through the data
 *   line's high phases.
 * - **highEdgeRatio** — fraction of SDA edges that land while SCL is high. On a
 *   real bus that's only START/STOP; but a mostly-high line masquerading as the
 *   clock collapses into one long high phase (so stability stays high) yet still
 *   swallows nearly every unrelated SDA edge — which this ratio exposes.
 *
 * Data edges coincident with an SCL edge are ignored (they sit on a phase
 * boundary, not inside the valid window).
 */
function analysePair(buf: CaptureBuffer, scl: number, sda: number): PairShape {
  let prevScl = buf.channelValueAt(scl, 0);
  let prevSda = buf.channelValueAt(sda, 0);
  let inHigh = prevScl === 1;
  let dirty = false;
  let highPhases = 0;
  let unstable = 0;
  let sdaEdgesHigh = 0;
  let sdaEdgesLow = 0;

  for (const i of buf.transitions()) {
    const s = buf.channelValueAt(scl, i);
    const d = buf.channelValueAt(sda, i);
    const sclChanged = s !== prevScl;
    const sdaChanged = d !== prevSda;

    if (sclChanged) {
      if (s === 1) {
        inHigh = true; // rising edge opens a new high phase
        dirty = false;
      } else {
        if (inHigh) {
          highPhases++;
          if (dirty) unstable++;
        }
        inHigh = false; // falling edge closes it
      }
    }
    if (sdaChanged) {
      // Classify the SDA edge by the SCL level it lands on. An edge coincident
      // with SCL falling counts as data setup (low) — that's how a coarse
      // capture records "data changes as the clock drops". Only an SDA edge with
      // SCL steady-high is a START/STOP (or a violation).
      if (s === 1) {
        sdaEdgesHigh++;
        if (inHigh && !sclChanged) dirty = true;
      } else {
        sdaEdgesLow++;
      }
    }
    prevScl = s;
    prevSda = d;
  }

  const totalEdges = sdaEdgesHigh + sdaEdgesLow;
  return {
    stability: highPhases > 0 ? 1 - unstable / highPhases : 0,
    highPhases,
    highEdgeRatio: totalEdges > 0 ? sdaEdgesHigh / totalEdges : 1,
  };
}

/**
 * Detect I²C on a specific `(scl, sda)` orientation. Returns the detection with a
 * confidence, or null if the pair doesn't behave like an I²C bus.
 */
export function detectI2c(
  buf: CaptureBuffer,
  scl: number,
  sda: number,
): I2cDetection | null {
  if (buf.sampleCount === 0 || scl === sda) return null;

  const { stability, highPhases, highEdgeRatio } = analysePair(buf, scl, sda);
  if (
    highPhases < MIN_HIGH_PHASES ||
    stability < MIN_STABILITY ||
    highEdgeRatio > MAX_HIGH_EDGE_RATIO
  )
    return null;

  // Confirm the pair frames into addressed bytes inside a complete transaction:
  // a START, at least a couple of bytes, and a STOP. Requiring the STOP rejects
  // pairs that merely produce a stray start-like edge and some clocking.
  const { annotations } = runDecoder(i2cDecoder, buf, [scl, sda], {});
  const hasStart = annotations.some((a) => a.annClass === ANN_START);
  const hasStop = annotations.some((a) => a.annClass === ANN_STOP);
  const byteCount = annotations.filter(
    (a) => a.annClass === ANN_ADDR || a.annClass === ANN_DATA,
  ).length;
  if (!hasStart || !hasStop || byteCount < MIN_BYTES) return null;

  return {
    kind: "i2c",
    channels: [scl, sda],
    byteCount,
    confidence: stability,
  };
}
