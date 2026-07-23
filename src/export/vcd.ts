import type { CaptureBuffer } from "../model/capture";
import { CHANNEL_NAMES } from "../usb/constants";
import type { ExportChunk } from "./stream";

/** Value-change groups per emitted chunk — bounds each chunk string to a few MB. */
export const VCD_CHANGES_PER_CHUNK = 32_768;

/**
 * Export a capture as VCD (Value Change Dump) in chunks, openable in GTKWave /
 * PulseView. Timestamps are in picoseconds so any fx2lafw sample rate maps to an
 * integer timescale exactly enough for waveform review. Concatenating every
 * chunk's `text` reproduces the whole file exactly.
 */
export function* vcdChunks(
  buf: CaptureBuffer,
  channels: number[],
  changesPerChunk = VCD_CHANGES_PER_CHUNK,
): Generator<ExportChunk> {
  const periodPs = Math.round(1e12 / buf.sampleRate);
  const ids = channels.map((_, i) => String.fromCharCode(0x21 + i)); // '!', '"', …
  const n = buf.sampleCount;

  const head: string[] = [];
  head.push(`$date web-logic-analyzer $end`);
  head.push(`$timescale 1 ps $end`);
  // Exact rate + length so our own importer round-trips precisely (VCD records
  // only value changes, so the total length and the trailing constant-level tail
  // aren't otherwise recoverable). Foreign readers ignore $comment.
  head.push(
    `$comment web-logic-analyzer samplerate=${buf.sampleRate} samples=${n} $end`,
  );
  head.push(`$scope module fx2la $end`);
  channels.forEach((c, i) =>
    head.push(`$var wire 1 ${ids[i]} ${CHANNEL_NAMES[c]} $end`),
  );
  head.push(`$upscope $end`);
  head.push(`$enddefinitions $end`);

  if (n === 0) {
    yield { text: head.join("\n") + "\n", processed: 0 };
    return;
  }

  // Initial values at t=0 go with the header block.
  head.push("#0");
  let prev = buf.byteAt(0);
  channels.forEach((c, i) => head.push(`${(prev >> c) & 1}${ids[i]}`));
  yield { text: head.join("\n"), processed: 0 };

  // Emit value changes only, batched into chunks by change-group count.
  let lines: string[] = [];
  let groups = 0;
  for (let s = 1; s < n; s++) {
    const cur = buf.byteAt(s);
    if (cur !== prev) {
      const changes: string[] = [];
      channels.forEach((c, i) => {
        const a = (prev >> c) & 1;
        const b = (cur >> c) & 1;
        if (a !== b) changes.push(`${b}${ids[i]}`);
      });
      if (changes.length) {
        lines.push(`#${s * periodPs}`, ...changes);
        groups++;
      }
      prev = cur;
    }
    if (groups >= changesPerChunk) {
      yield { text: "\n" + lines.join("\n"), processed: s + 1 };
      lines = [];
      groups = 0;
    }
  }
  // A final timestamp at the end of the last sample's interval marks the capture
  // duration, so time-based viewers (GTKWave/PulseView) show the full length
  // rather than ending at the last edge. Our own importer uses the $comment
  // sample count and treats this trailing marker as a no-op.
  lines.push(`#${n * periodPs}`);
  // Flush the tail plus the file's trailing newline.
  yield { text: "\n" + lines.join("\n") + "\n", processed: n };
}

/** Full-string VCD — convenient for small captures and tests. */
export function toVcd(buf: CaptureBuffer, channels: number[]): string {
  let out = "";
  for (const chunk of vcdChunks(buf, channels)) out += chunk.text;
  return out;
}
