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

/** Minimal shape of the File System Access API bits we use. */
interface SaveHandle {
  createWritable(): Promise<{
    write(data: string): Promise<void>;
    close(): Promise<void>;
  }>;
}
type SavePicker = (opts: {
  suggestedName: string;
  types: Array<{ description: string; accept: Record<string, string[]> }>;
}) => Promise<SaveHandle>;

/** True when the browser can write a file incrementally (Chromium). */
export function canStreamToDisk(): boolean {
  return (
    typeof (window as { showSaveFilePicker?: SavePicker })
      .showSaveFilePicker === "function"
  );
}

/**
 * Write a chunked export straight to a file the user picks, one chunk at a time.
 *
 * This is the only path that survives a large capture: a 100M-sample CSV is
 * ~4.3 GB of text, and holding it as JS strings (UTF-16, so ~8.6 GB) exceeds
 * Chrome's renderer heap and kills the tab before any Blob is built. Writing
 * through a file handle keeps only the current chunk in memory.
 *
 * Returns false if the user cancelled the picker. Must be called from a user
 * gesture, so do not await anything before it.
 */
export async function streamChunksToDisk(
  filename: string,
  mime: string,
  total: number,
  chunks: Iterable<ExportChunk>,
  onProgress?: (fraction: number) => void,
): Promise<boolean> {
  const picker = (window as { showSaveFilePicker?: SavePicker })
    .showSaveFilePicker;
  if (!picker) throw new Error("File streaming is unavailable.");
  let handle: SaveHandle;
  try {
    handle = await picker({
      suggestedName: filename,
      types: [
        {
          description: "Capture",
          accept: { [mime]: [`.${filename.split(".").pop()}`] },
        },
      ],
    });
  } catch {
    return false; // cancelled
  }
  const file = await handle.createWritable();
  try {
    for (const chunk of chunks) {
      await file.write(chunk.text);
      if (onProgress && total > 0) onProgress(chunk.processed / total);
    }
  } finally {
    await file.close();
  }
  onProgress?.(1);
  return true;
}

/**
 * Assemble a chunked export into a Blob and download it, yielding to the event
 * loop periodically so the tab keeps painting. No giant string is built, but
 * every chunk is retained until the Blob is constructed, so peak memory is the
 * whole file (doubled, strings being UTF-16) — fine for a modest capture, fatal
 * for a large one. Prefer streamChunksToDisk; this is the fallback for browsers
 * without the File System Access API. `onProgress` receives a 0..1 fraction.
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
