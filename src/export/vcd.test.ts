import { describe, expect, it } from "vitest";
import { CaptureBuffer } from "../model/capture";
import { toVcd, vcdChunks } from "./vcd";

describe("toVcd", () => {
  it("emits a header and value changes for one channel", () => {
    const buf = new CaptureBuffer(1_000_000, 16);
    // channel 0 toggles: 0,0,1,1
    buf.append(new Uint8Array([0x00, 0x00, 0x01, 0x01]));

    const vcd = toVcd(buf, [0]);
    expect(vcd).toContain("$timescale 1 ps $end");
    expect(vcd).toContain("$var wire 1 ! D0 $end");
    expect(vcd).toContain("#0");
    expect(vcd).toContain("0!"); // initial low
    // change to high happens at sample 2 -> 2 * (1e12/1e6) = 2_000_000 ps
    expect(vcd).toContain("#2000000");
    expect(vcd).toContain("1!");
  });

  it("marks the capture end with a trailing timestamp at n · period", () => {
    const buf = new CaptureBuffer(1_000_000, 16);
    // 4 samples at 1 MHz ⇒ 1e6 ps/sample; the last edge is at sample 2, but the
    // end marker sits at 4 · 1e6 = 4000000 so the full duration is preserved.
    buf.append(new Uint8Array([0x00, 0x00, 0x01, 0x01]));
    const vcd = toVcd(buf, [0]);
    expect(vcd.trimEnd().endsWith("#4000000")).toBe(true);
  });
});

describe("vcdChunks", () => {
  it("chunks value-changes and concatenates to the full VCD", () => {
    const buf = new CaptureBuffer(1_000_000, 16);
    // channel 0 toggles every sample -> a change at samples 1..5
    buf.append(new Uint8Array([0, 1, 0, 1, 0, 1]));
    const chunks = [...vcdChunks(buf, [0], 2)]; // 2 change-groups per chunk

    expect(chunks.map((c) => c.text).join("")).toBe(toVcd(buf, [0]));
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.at(-1)?.processed).toBe(buf.sampleCount);
  });

  it("handles an empty capture", () => {
    const buf = new CaptureBuffer(1_000_000, 16);
    const chunks = [...vcdChunks(buf, [0])];
    expect(chunks.map((c) => c.text).join("")).toBe(toVcd(buf, [0]));
  });
});
