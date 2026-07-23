import type { CaptureBuffer } from "../model/capture";
import { CHANNEL_NAMES } from "../usb/constants";
import type { ExportChunk } from "./stream";

/** Rows per emitted chunk — bounds each chunk string to a few MB. */
export const CSV_ROWS_PER_CHUNK = 65_536;

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
    lines.push(`${i},${(i * dt).toExponential(6)},${cols.join(",")}`);
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
