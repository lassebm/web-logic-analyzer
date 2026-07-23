import { describe, expect, it } from "vitest";
import { CaptureBuffer } from "../model/capture";
import { toCsv } from "../export/csv";
import { toVcd } from "../export/vcd";
import { importFile } from "./importer";

function bufOf(bytes: number[], rate = 1_000_000): CaptureBuffer {
  const b = new CaptureBuffer(rate, 64);
  b.append(new Uint8Array(bytes));
  return b;
}

function fileOf(text: string, name: string): File {
  return new File([text], name, { type: "text/plain" });
}

function bytesOf(buf: CaptureBuffer): number[] {
  return Array.from({ length: buf.sampleCount }, (_, i) => buf.byteAt(i));
}

describe("importFile (streaming)", () => {
  it("streams a CSV export back into an equivalent capture buffer", async () => {
    const src = bufOf([0b01, 0b10, 0b11, 0b00], 2_000_000);
    const out = await importFile(fileOf(toCsv(src, [0, 1]), "capture.csv"));
    expect(out.sampleRate).toBe(2_000_000);
    expect(bytesOf(out)).toEqual([0b01, 0b10, 0b11, 0b00]);
  });

  it("streams a VCD export back into an equivalent capture buffer", async () => {
    const src = bufOf([0, 1, 0, 1, 0, 1], 1_000_000);
    const out = await importFile(fileOf(toVcd(src, [0]), "capture.vcd"));
    expect(out.sampleRate).toBe(1_000_000);
    expect(bytesOf(out)).toEqual([0, 1, 0, 1, 0, 1]);
  });

  it("preserves the full VCD length past the last edge", async () => {
    // Last edge at sample 1; samples 2..7 are constant. The whole length must
    // survive the round-trip, not truncate at the last change.
    const src = bufOf([1, 0, 0, 0, 0, 0, 0, 0], 1_000_000);
    const out = await importFile(fileOf(toVcd(src, [0]), "tail.vcd"));
    expect(out.sampleCount).toBe(8);
    expect(bytesOf(out)).toEqual([1, 0, 0, 0, 0, 0, 0, 0]);
  });

  it("crosses read-chunk boundaries without corrupting rows", async () => {
    // ~5000 rows of CSV comfortably exceeds a single decode() call's tail and
    // exercises the partial-line carry across slices.
    const n = 5000;
    const src = new CaptureBuffer(1_000_000, n);
    const bytes = new Uint8Array(n);
    for (let i = 0; i < n; i++) bytes[i] = i & 1; // ch0 toggles
    src.append(bytes);

    const out = await importFile(fileOf(toCsv(src, [0]), "big.csv"));
    expect(out.sampleCount).toBe(n);
    expect(out.byteAt(0)).toBe(0);
    expect(out.byteAt(n - 1)).toBe((n - 1) & 1);
  });

  it("reports progress ending at 1", async () => {
    const src = bufOf([1, 0, 1], 1_000_000);
    const seen: number[] = [];
    await importFile(fileOf(toCsv(src, [0]), "p.csv"), (f) => seen.push(f));
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.at(-1)).toBe(1);
  });

  it("rejects an unrecognized file", async () => {
    await expect(importFile(fileOf("just notes", "notes.txt"))).rejects.toThrow(
      /unrecognized/i,
    );
  });

  it("aborts a file with a pathologically long line (no newline)", async () => {
    // Without a newline, streamLines' carry would otherwise grow to the whole
    // file; the 16 MiB cap must abort instead of exhausting memory.
    const huge = "x".repeat((16 << 20) + 4096); // > 16 MiB, no "\n"
    await expect(importFile(fileOf(huge, "nolines.csv"))).rejects.toThrow(
      /newline|corrupt/i,
    );
  });
});
