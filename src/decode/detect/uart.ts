/**
 * UART auto-detection. Given a captured channel, guess whether it carries
 * asynchronous serial data and, if so, recover its baud rate and framing
 * (data bits, parity, inversion).
 *
 * Strategy: every pulse on a UART line is an integer multiple of one bit
 * period, so edge timing gives an initial baud estimate. That estimate only
 * bounds a small set of standard-baud candidates — the real decision comes from
 * *trial-decoding* each candidate with the existing UART decoder and scoring how
 * cleanly it frames. The best-scoring config above a confidence threshold is the
 * detection; nothing above threshold means "not UART".
 *
 * Pure and dependency-free (no DOM / stores) so it stays unit-testable like the
 * decoders themselves.
 */
import type { CaptureBuffer } from "../../model/capture";
import { runDecoder } from "../engine";
import { uartDecoder } from "../decoders/uart";
import type { UartDetection } from "./types";

/** Common UART baud rates, ascending. */
export const STANDARD_BAUDS = [
  300, 1200, 2400, 4800, 9600, 19200, 38400, 57600, 74880, 115200, 230400,
  250000, 460800, 500000, 921600, 1000000,
];

/** The UART decoder's error annotation classes (see decoders/uart.ts). */
const ANN_PARITY_ERR = 4;
const ANN_FRAME_ERR = 5;

/** Minimum samples-per-bit for a trustworthy decode (mirrors the ">= 4x" guidance). */
const MIN_SPB = 4;
/** Reject a detection unless at least this many frames decoded cleanly enough. */
const MIN_FRAMES = 4;
/** Minimum clean-frame ratio to call a channel UART. */
const MIN_CONFIDENCE = 0.8;
/** Candidate bauds are kept within this factor of the edge-timing estimate. */
const CANDIDATE_FACTOR = 3;

/**
 * Data-bit widths to try, most-common first. 7/8 dominate real traffic; 9-bit
 * (multiprocessor / address-mark) is rare but distinguishable. 5/6-bit (Baudot)
 * are omitted — vanishingly rare and they collide with the parity variants,
 * inviting false positives.
 */
const DATA_BITS = [8, 7, 9];
const PARITIES = ["none", "even", "odd"] as const;
const INVERSIONS = ["no", "yes"] as const;

interface Candidate {
  baudrate: number;
  data_bits: number;
  parity: "none" | "odd" | "even";
  invert: "no" | "yes";
}

interface Scored extends Candidate {
  frames: number;
  confidence: number;
  /** Distinct decoded byte values — guards against a clock aliasing to one repeated value. */
  distinctValues: number;
}

/** Sample indices where `channel` changes value (per-channel edges). */
function channelEdges(buf: CaptureBuffer, channel: number): number[] {
  const edges: number[] = [];
  for (const i of buf.transitions()) {
    if (buf.channelValueAt(channel, i) !== buf.channelValueAt(channel, i - 1))
      edges.push(i);
  }
  return edges;
}

/**
 * Robust estimate of the shortest pulse width (≈ one bit period) from edge
 * timing. Drops the smallest ~2% of gaps as potential glitches so a single
 * noise spike can't collapse the estimate.
 */
function robustUnitWidth(edges: number[]): number {
  const gaps: number[] = [];
  for (let i = 1; i < edges.length; i++) gaps.push(edges[i] - edges[i - 1]);
  if (gaps.length === 0) return 0;
  gaps.sort((a, b) => a - b);
  const idx = Math.min(gaps.length - 1, Math.floor(gaps.length * 0.02));
  let unit = gaps[idx];
  if (unit < 1) unit = gaps.find((g) => g >= 1) ?? 1;
  return unit;
}

/** Build the trial-decode candidate grid near the estimated baud. */
function candidatesFor(sampleRate: number, estBaud: number): Candidate[] {
  const lo = estBaud / CANDIDATE_FACTOR;
  const hi = estBaud * CANDIDATE_FACTOR;
  const nearest = STANDARD_BAUDS.reduce((best, b) =>
    Math.abs(b - estBaud) < Math.abs(best - estBaud) ? b : best,
  );
  const bauds = STANDARD_BAUDS.filter(
    (b) => sampleRate / b >= MIN_SPB && ((b >= lo && b <= hi) || b === nearest),
  );

  const out: Candidate[] = [];
  for (const baudrate of bauds)
    for (const data_bits of DATA_BITS)
      for (const parity of PARITIES)
        for (const invert of INVERSIONS)
          out.push({ baudrate, data_bits, parity, invert });
  return out;
}

/** Trial-decode one candidate and score its framing cleanliness. */
function score(
  buf: CaptureBuffer,
  channel: number,
  c: Candidate,
): Scored | null {
  const { annotations, packets } = runDecoder(uartDecoder, buf, [channel], {
    baudrate: c.baudrate,
    data_bits: c.data_bits,
    parity: c.parity,
    stop_bits: 1,
    bit_order: "lsb-first",
    invert: c.invert,
  });
  const frames = packets.length;
  if (frames === 0) return null;
  const errors = annotations.filter(
    (a) => a.annClass === ANN_FRAME_ERR || a.annClass === ANN_PARITY_ERR,
  ).length;
  const confidence = Math.max(0, (frames - errors) / frames);
  const distinctValues = new Set(
    packets.map((p) => (p.data as { value: number }).value),
  ).size;
  return { ...c, frames, confidence, distinctValues };
}

/**
 * Rank ties toward the most common framing. Data-bit deviation is penalised
 * more than parity so an ambiguous frame that fits two readings equally well
 * (e.g. 8-E-1 vs 9-N-1 — identical on the wire) resolves to the standard
 * 8-bit-with-parity interpretation rather than an exotic width.
 */
function simplicity(c: Candidate): number {
  return (
    Math.abs(c.data_bits - 8) * 2 +
    (c.parity === "none" ? 0 : 1) +
    (c.invert === "no" ? 0 : 1)
  );
}

/**
 * Detect UART on a single channel. Returns the recovered parameters with a
 * confidence, or null if the channel doesn't look like UART.
 */
export function detectUart(
  buf: CaptureBuffer,
  channel: number,
): UartDetection | null {
  if (buf.sampleCount === 0) return null;

  const edges = channelEdges(buf, channel);
  if (edges.length < 4) return null; // idle / static line

  const unit = robustUnitWidth(edges);
  if (unit < 1) return null;
  const estBaud = buf.sampleRate / unit;

  const candidates = candidatesFor(buf.sampleRate, estBaud);
  if (candidates.length === 0) return null; // sample rate too low for any baud

  // Keep only candidates that frame cleanly enough to be plausibly UART. A
  // constant repeating byte (< 2 distinct values) is how a plain clock aliases,
  // so it doesn't count as data.
  const viable = candidates
    .map((c) => score(buf, channel, c))
    .filter(
      (s): s is Scored =>
        s !== null &&
        s.frames >= MIN_FRAMES &&
        s.confidence >= MIN_CONFIDENCE &&
        s.distinctValues >= 2,
    );
  if (viable.length === 0) return null;

  // The narrowest-pulse estimate is the strongest baud signal, so pick the
  // viable config whose baud is closest to it; break ties toward higher
  // confidence, more frames, then the simplest framing (plain 8-N-1).
  const dist = (b: number) => Math.abs(Math.log(b / estBaud));
  viable.sort(
    (a, b) =>
      dist(a.baudrate) - dist(b.baudrate) ||
      b.confidence - a.confidence ||
      b.frames - a.frames ||
      simplicity(a) - simplicity(b),
  );
  const best = viable[0];

  return {
    kind: "uart",
    channels: [channel],
    baudrate: best.baudrate,
    data_bits: best.data_bits,
    parity: best.parity,
    invert: best.invert,
    frameCount: best.frames,
    confidence: best.confidence,
  };
}
