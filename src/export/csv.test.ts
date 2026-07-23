import { describe, expect, it } from "vitest";
import { CaptureBuffer } from "../model/capture";
import { toCsv, csvChunks } from "./csv";

describe("toCsv", () => {
  it("writes a header and one row per sample with per-channel bits", () => {
    const buf = new CaptureBuffer(1_000_000, 4);
    buf.append(new Uint8Array([0b01, 0b10])); // ch0,ch1
    const rows = toCsv(buf, [0, 1]).trim().split("\n");

    expect(rows[0]).toBe("sample,time_s,D0,D1");
    // sample 0: ch0=1, ch1=0
    expect(rows[1].startsWith("0,")).toBe(true);
    expect(rows[1].endsWith(",1,0")).toBe(true);
    // sample 1: ch0=0, ch1=1
    expect(rows[2].startsWith("1,")).toBe(true);
    expect(rows[2].endsWith(",0,1")).toBe(true);
    expect(rows.length).toBe(3);
  });

  it("includes only the requested channels", () => {
    const buf = new CaptureBuffer(1_000_000, 4);
    buf.append(new Uint8Array([0xff]));
    const rows = toCsv(buf, [3]).trim().split("\n");
    expect(rows[0]).toBe("sample,time_s,D3");
    expect(rows[1].endsWith(",1")).toBe(true);
  });
});

describe("csvChunks", () => {
  it("chunks concatenate to the full CSV, with monotonic sample progress", () => {
    const buf = new CaptureBuffer(1_000_000, 4);
    buf.append(new Uint8Array([0, 1, 2, 3, 0, 1, 2, 3])); // 8 samples
    const chunks = [...csvChunks(buf, [0, 1], 3)]; // 3 rows per chunk

    // Byte-identical to the full-string export.
    expect(chunks.map((c) => c.text).join("")).toBe(toCsv(buf, [0, 1]));
    // 1 header chunk + ceil(8 / 3) = 3 data chunks.
    expect(chunks.length).toBe(4);

    const processed = chunks.map((c) => c.processed);
    expect(processed[0]).toBe(0); // header
    expect(processed.at(-1)).toBe(8); // all samples
    for (let i = 1; i < processed.length; i++) {
      expect(processed[i]).toBeGreaterThanOrEqual(processed[i - 1]);
    }
  });

  it("handles an empty capture", () => {
    const buf = new CaptureBuffer(1_000_000, 4);
    const chunks = [...csvChunks(buf, [0, 1])];
    expect(chunks.map((c) => c.text).join("")).toBe(toCsv(buf, [0, 1]));
    // Header only, no data rows.
    expect(chunks.length).toBe(1);
    expect(chunks[0].text).toBe("sample,time_s,D0,D1");
  });
});
