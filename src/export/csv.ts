import type { CaptureBuffer } from "../model/capture";
import { CHANNEL_NAMES } from "../usb/constants";
import type { ExportChunk } from "./stream";

/** Rows per emitted chunk — bounds each chunk string to a few MB. */
export const CSV_ROWS_PER_CHUNK = 65_536;

/**
 * Significant decimals in the `time_s` column. Importing recovers the sample
 * rate from the first two timestamps (`rateFromStep`), so the step has to be
 * precise enough to round-trip every entry of SAMPLE_RATES: at 7 digits, 24 MHz
 * came back as 23999998 — a rate no fx2lafw clock divider can produce, which
 * then failed the next capture. 12 also keeps timestamps distinct far deeper
 * into a long capture.
 */
const TIME_DIGITS = 12;

/**
 * Export a capture as CSV in chunks (one row per sample), so huge captures
 * stream to a Blob instead of building one gigantic string. `channels` is the
 * list of physical channel indices to include. Concatenating every chunk's
 * `text` reproduces the whole file exactly.
 */
export function* csvChunks(
  buf: CaptureBuffer,
  channels: number[],
  rowsPerChunk = CSV_ROWS_PER_CHUNK,
): Generator<ExportChunk> {
  const header = ["sample", "time_s", ...channels.map((c) => CHANNEL_NAMES[c])];
  yield { text: header.join(","), processed: 0 };

  const n = buf.sampleCount;
  const dt = 1 / buf.sampleRate;
  let lines: string[] = [];
  for (let i = 0; i < n; i++) {
    const byte = buf.byteAt(i);
    const cols = channels.map((c) => (byte >> c) & 1);
    lines.push(`${i},${(i * dt).toExponential(TIME_DIGITS)},${cols.join(",")}`);
    if (lines.length >= rowsPerChunk) {
      yield { text: "\n" + lines.join("\n"), processed: i + 1 };
      lines = [];
    }
  }
  if (lines.length) yield { text: "\n" + lines.join("\n"), processed: n };
}

/** Full-string CSV — convenient for small captures and tests. */
export function toCsv(buf: CaptureBuffer, channels: number[]): string {
  let out = "";
  for (const chunk of csvChunks(buf, channels)) out += chunk.text;
  return out;
}
