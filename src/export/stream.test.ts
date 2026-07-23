// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { downloadChunks, type ExportChunk } from "./stream";

// jsdom implements neither URL.createObjectURL nor anchor navigation; stub them
// so downloadChunks' final downloadBlob doesn't attempt a real download.
beforeEach(() => {
  const createURL = vi.fn().mockReturnValue("blob:test");
  (URL as unknown as { createObjectURL: unknown }).createObjectURL = createURL;
  (URL as unknown as { revokeObjectURL: unknown }).revokeObjectURL = vi.fn();
  HTMLAnchorElement.prototype.click = vi.fn();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("downloadChunks", () => {
  it("reports monotonic progress in [0,1] ending at exactly 1", async () => {
    const total = 8;
    const chunks: ExportChunk[] = [
      { text: "header", processed: 0 },
      { text: "\na", processed: 3 },
      { text: "\nb", processed: 6 },
      { text: "\nc", processed: 8 },
    ];

    const seen: number[] = [];
    await downloadChunks("out.csv", "text/csv", total, chunks, (f) =>
      seen.push(f),
    );

    // One fraction per chunk, plus the final onProgress(1).
    expect(seen).toEqual([0, 3 / 8, 6 / 8, 1, 1]);
    expect(seen.at(-1)).toBe(1);
    for (const f of seen) {
      expect(f).toBeGreaterThanOrEqual(0);
      expect(f).toBeLessThanOrEqual(1);
    }
    for (let i = 1; i < seen.length; i++) {
      expect(seen[i]).toBeGreaterThanOrEqual(seen[i - 1]);
    }
  });

  it("still emits a final onProgress(1) when total is 0 (no per-chunk fractions)", async () => {
    const seen: number[] = [];
    await downloadChunks(
      "out.csv",
      "text/csv",
      0,
      [{ text: "header", processed: 0 }],
      (f) => seen.push(f),
    );
    expect(seen).toEqual([1]);
  });

  it("assembles every chunk's text into the downloaded blob", async () => {
    const createURL = URL.createObjectURL as unknown as ReturnType<
      typeof vi.fn
    >;
    await downloadChunks("out.csv", "text/csv", 2, [
      { text: "a", processed: 1 },
      { text: "b", processed: 2 },
    ]);
    expect(createURL).toHaveBeenCalledOnce();
    const blob = createURL.mock.calls[0][0] as Blob;
    expect(blob.type).toBe("text/csv");
    expect(await blob.text()).toBe("ab");
  });

  it("yields to the event loop when a chunk crosses the throttle window", async () => {
    // Force the elapsed-time check past the ~12ms threshold on the first chunk
    // so the throttled `await yieldToLoop()` branch runs deterministically.
    let t = 0;
    vi.spyOn(performance, "now").mockImplementation(() => {
      const now = t;
      t += 100;
      return now;
    });

    const seen: number[] = [];
    await downloadChunks(
      "out.csv",
      "text/csv",
      2,
      [
        { text: "a", processed: 1 },
        { text: "b", processed: 2 },
      ],
      (f) => seen.push(f),
    );
    expect(seen.at(-1)).toBe(1);
  });
});
