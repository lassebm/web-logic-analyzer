import { downloadBlob } from "./download";

export interface ExportChunk {
  /** A slice of the output; concatenating every chunk's text is the full file. */
  text: string;
  /** Cumulative samples processed so far, for progress reporting. */
  processed: number;
}

/** Yield to the event loop so the tab can paint/respond between big chunks. */
function yieldToLoop(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * Assemble a chunked export into a Blob and download it, yielding to the event
 * loop periodically. A 100M-row CSV runs to gigabytes — far past V8's ~512M-char
 * single-string limit — so we never build one giant string: each chunk is a
 * bounded string pushed into a `Blob` parts array. Yielding keeps the tab from
 * freezing (and hanging Chrome's "page unresponsive" dialog) and lets progress
 * paint. `onProgress` receives a 0..1 fraction.
 */
export async function downloadChunks(
  filename: string,
  mime: string,
  total: number,
  chunks: Iterable<ExportChunk>,
  onProgress?: (fraction: number) => void,
): Promise<void> {
  const parts: BlobPart[] = [];
  let last = performance.now();
  for (const chunk of chunks) {
    parts.push(chunk.text);
    if (onProgress && total > 0) onProgress(chunk.processed / total);
    // Time-based (~every 12ms) so the macrotask count stays bounded regardless
    // of chunk size.
    if (performance.now() - last >= 12) {
      last = performance.now();
      await yieldToLoop();
    }
  }
  downloadBlob(filename, new Blob(parts, { type: mime }));
  onProgress?.(1);
}
