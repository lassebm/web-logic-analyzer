import { CaptureBuffer } from "../model/capture";
import {
  DEFAULT_RATE,
  VcdAccumulator,
  csvRowTime,
  csvRowToByte,
  detectFormat,
  parseCsvHeader,
  rateFromStep,
} from "./parse";

/** Bytes read per slice. Bounds peak memory regardless of file size. */
const READ_CHUNK = 1 << 20; // 1 MiB
/** Samples appended to the buffer per batch (CSV). */
const APPEND_BATCH = 1 << 16;
/**
 * Cap on an un-terminated line. The slice-streaming design keeps peak memory
 * bounded only if lines end — a file with no newline would otherwise grow
 * `carry` to the whole file (OOM / V8 string-limit throw). Real CSV rows and VCD
 * lines are tiny, so 16 MiB is a generous ceiling that only trips on bad input.
 */
const MAX_LINE_BYTES = 16 << 20; // 16 MiB

/**
 * Read a File as text, a slice at a time, invoking `onLine` for each complete
 * line. Never materializes the whole file as one string (a large export would
 * blow past V8's string limit), and each `await` yields to the event loop so the
 * tab stays responsive; `onProgress` reports a 0..1 fraction of bytes read.
 */
async function streamLines(
  file: File,
  onLine: (line: string) => void,
  onProgress?: (fraction: number) => void,
): Promise<void> {
  const decoder = new TextDecoder();
  const size = file.size || 1;
  let carry = "";

  const consume = (text: string) => {
    carry += text;
    let nl: number;
    while ((nl = carry.indexOf("\n")) >= 0) {
      const line = carry.slice(0, nl);
      carry = carry.slice(nl + 1);
      onLine(line.endsWith("\r") ? line.slice(0, -1) : line);
    }
    if (carry.length > MAX_LINE_BYTES) {
      throw new Error(
        "A single line exceeds 16 MiB without a newline — file looks corrupt.",
      );
    }
  };

  for (let off = 0; off < file.size; off += READ_CHUNK) {
    const bytes = new Uint8Array(
      await file.slice(off, off + READ_CHUNK).arrayBuffer(),
    );
    consume(decoder.decode(bytes, { stream: true }));
    onProgress?.(Math.min((off + bytes.length) / size, 0.99));
  }
  consume(decoder.decode()); // flush any multibyte tail
  if (carry !== "") onLine(carry.endsWith("\r") ? carry.slice(0, -1) : carry);
  onProgress?.(1);
}

async function importCsv(
  file: File,
  onProgress?: (fraction: number) => void,
): Promise<CaptureBuffer> {
  let cols: number[] | null = null;
  let rate = DEFAULT_RATE;
  let buf: CaptureBuffer | null = null;
  const times: number[] = [];
  const pending: number[] = []; // samples buffered until the rate is known
  const batch = new Uint8Array(APPEND_BATCH);
  let bi = 0;

  // The buffer's sample rate is fixed at construction, but we only learn it from
  // the first two rows — so hold early samples until then, then create + flush.
  const ensureBuf = (): CaptureBuffer => {
    if (!buf) {
      buf = new CaptureBuffer(rate, APPEND_BATCH);
      if (pending.length) {
        buf.append(Uint8Array.from(pending));
        pending.length = 0;
      }
    }
    return buf;
  };

  await streamLines(
    file,
    (line) => {
      if (line.trim() === "") return;
      if (cols === null) {
        cols = parseCsvHeader(line);
        return;
      }
      const byte = csvRowToByte(line, cols);
      if (times.length < 2) {
        times.push(csvRowTime(line));
        if (times.length === 2) rate = rateFromStep(times[0], times[1]);
      }
      if (!buf) {
        pending.push(byte);
        if (times.length >= 2) ensureBuf(); // rate known → materialize
      } else {
        batch[bi++] = byte;
        if (bi === APPEND_BATCH) {
          buf.append(batch.subarray(0, bi));
          bi = 0;
        }
      }
    },
    onProgress,
  );

  // ensureBuf always yields a buffer (covers files with < 2 rows: default rate,
  // flush pending). Append any partial final batch.
  const result = ensureBuf();
  if (bi) result.append(batch.subarray(0, bi));
  return result;
}

async function importVcd(
  file: File,
  onProgress?: (fraction: number) => void,
): Promise<CaptureBuffer> {
  const acc = new VcdAccumulator();
  await streamLines(file, (line) => acc.line(line), onProgress);
  const parsed = acc.finish();
  const buf = new CaptureBuffer(
    parsed.sampleRate,
    Math.max(parsed.samples.length, 1),
  );
  buf.append(parsed.samples);
  return buf;
}

/**
 * Import a CSV/VCD capture file into a CaptureBuffer, streaming so large files
 * neither freeze the tab nor exceed the browser's string limit. Detects the
 * format by extension, falling back to sniffing a small head slice.
 */
export async function importFile(
  file: File,
  onProgress?: (fraction: number) => void,
): Promise<CaptureBuffer> {
  const head = await file.slice(0, 512).text();
  const format = detectFormat(file.name, head);
  if (!format)
    throw new Error("Unrecognized file — expected a .csv or .vcd export.");
  return format === "vcd"
    ? importVcd(file, onProgress)
    : importCsv(file, onProgress);
}
