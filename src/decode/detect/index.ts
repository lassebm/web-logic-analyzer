/**
 * Protocol auto-detection entry point. `scanChannels` runs every detector over
 * the active channels and returns the combined hits; the UI renders them
 * generically via each detection's `kind`.
 *
 * Detectors differ in arity: UART is per-channel, I²C is per channel *pair* (and
 * per orientation, since which line is SCL isn't known up front). New protocols
 * plug in here without the store or UI needing to know their shape.
 */
import type { CaptureBuffer } from "../../model/capture";
import { detectUart } from "./uart";
import { detectI2c } from "./i2c";
import type { Detection, I2cDetection } from "./types";

export { detectUart } from "./uart";
export { detectI2c } from "./i2c";
export {
  detectionToDecoder,
  type Detection,
  type UartDetection,
  type I2cDetection,
  type DecoderSpec,
} from "./types";

/** Best of the two I²C orientations for a pair, or null if neither fits. */
function detectI2cPair(
  buf: CaptureBuffer,
  a: number,
  b: number,
): I2cDetection | null {
  const forward = detectI2c(buf, a, b);
  const swapped = detectI2c(buf, b, a);
  if (forward && swapped)
    return forward.confidence >= swapped.confidence ? forward : swapped;
  return forward ?? swapped;
}

/**
 * Scan the given channels for every supported protocol. Returns all hits sorted
 * by their first channel (then by protocol), so the panel lists them stably.
 *
 * Multi-channel protocols are matched first and *claim* their lines: an I²C bus
 * is a strong, structural signal, so its SCL/SDA are not then re-reported as
 * standalone UART (a clock line or a data line can otherwise trial-decode as
 * serial). Single-channel detectors only run on the leftover channels.
 */
export function scanChannels(
  buf: CaptureBuffer,
  channels: number[],
): Detection[] {
  const hits: Detection[] = [];
  const claimed = new Set<number>();

  // I²C: score every unordered channel pair, then claim strongest-first. Sorting
  // by confidence (then byte count) before claiming means a weak, coincidental
  // pair can't grab a line that belongs to a stronger, real bus.
  const i2cCandidates: I2cDetection[] = [];
  for (let i = 0; i < channels.length; i++)
    for (let j = i + 1; j < channels.length; j++) {
      const d = detectI2cPair(buf, channels[i], channels[j]);
      if (d) i2cCandidates.push(d);
    }
  i2cCandidates.sort(
    (x, y) => y.confidence - x.confidence || y.byteCount - x.byteCount,
  );
  for (const d of i2cCandidates) {
    const [a, b] = d.channels;
    if (claimed.has(a) || claimed.has(b)) continue;
    hits.push(d);
    claimed.add(a);
    claimed.add(b);
  }

  // UART: one candidate per remaining (unclaimed) channel.
  for (const ch of channels) {
    if (claimed.has(ch)) continue;
    const u = detectUart(buf, ch);
    if (u) hits.push(u);
  }

  return hits.sort(
    (x, y) => x.channels[0] - y.channels[0] || x.kind.localeCompare(y.kind),
  );
}
