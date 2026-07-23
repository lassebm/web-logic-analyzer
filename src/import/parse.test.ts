import { describe, expect, it } from "vitest";
import { CaptureBuffer } from "../model/capture";
import { toCsv } from "../export/csv";
import { toVcd } from "../export/vcd";
import {
  parseCsv,
  parseVcd,
  detectFormat,
  parseCapture,
  rateFromStep,
  DEFAULT_RATE,
  MAX_SAMPLES,
} from "./parse";
import { CHANNEL_NAMES } from "../usb/constants";

function bufOf(bytes: number[], rate = 1_000_000): CaptureBuffer {
  const b = new CaptureBuffer(rate, 64);
  b.append(new Uint8Array(bytes));
  return b;
}

describe("parseCsv", () => {
  it("round-trips a CSV export (samples for the exported channels + rate)", () => {
    const buf = bufOf([0b01, 0b10, 0b11, 0b00], 2_000_000);
    const csv = toCsv(buf, [0, 1]);
    const parsed = parseCsv(csv);

    expect(parsed.sampleRate).toBe(2_000_000);
    // Only channels 0 and 1 were exported, so only those bits are reconstructed.
    expect([...parsed.samples]).toEqual([0b01, 0b10, 0b11, 0b00]);
  });

  it("maps named channel columns back to their indices", () => {
    const buf = bufOf([0xff, 0x00], 1_000_000);
    const parsed = parseCsv(toCsv(buf, [3, 5]));
    expect([...parsed.samples]).toEqual([(1 << 3) | (1 << 5), 0]);
  });

  it("rejects a file with the wrong header or no content", () => {
    expect(() => parseCsv("")).toThrow(/empty/i);
    expect(() => parseCsv("foo,bar\n1,2")).toThrow(/header/i);
    expect(() => parseCsv("sample,time_s,DX\n0,0,1")).toThrow(/DX/);
  });
});

describe("parseVcd", () => {
  it("round-trips a VCD export", () => {
    const buf = bufOf([0, 1, 0, 1, 0, 1], 1_000_000); // ch0 toggles each sample
    const parsed = parseVcd(toVcd(buf, [0]));
    expect(parsed.sampleRate).toBe(1_000_000);
    expect([...parsed.samples]).toEqual([0, 1, 0, 1, 0, 1]);
  });

  it("reconstructs multiple channels and holds levels between changes", () => {
    const buf = bufOf([0b01, 0b11, 0b01, 0b11], 4_000_000);
    const parsed = parseVcd(toVcd(buf, [0, 1]));
    expect(parsed.sampleRate).toBe(4_000_000);
    expect([...parsed.samples]).toEqual([0b01, 0b11, 0b01, 0b11]);
  });

  it("preserves trailing constant samples after the last edge (via $comment)", () => {
    // One edge at sample 1, then constant to sample 5. The exact length comes
    // from the exporter's $comment, not the last timestamp.
    const buf = bufOf([0, 1, 1, 1, 1, 1], 2_000_000);
    const parsed = parseVcd(toVcd(buf, [0]));
    expect(parsed.sampleRate).toBe(2_000_000);
    expect([...parsed.samples]).toEqual([0, 1, 1, 1, 1, 1]);
  });

  it("falls back to GCD period recovery for a VCD without our $comment", () => {
    // Hand-written (foreign) VCD: rate 4 MHz ⇒ 250000 ps/sample; a single change
    // at sample 2 (t=500000). With no length/rate metadata, the period reads back
    // as the GCD (500000) — half the true rate — and length from the last change.
    const raw = [
      "$timescale 1 ps $end",
      "$var wire 1 ! D0 $end",
      '$var wire 1 " D1 $end',
      "$enddefinitions $end",
      "#0",
      "0!",
      '0"',
      "#500000",
      '1"',
      "",
    ].join("\n");
    const parsed = parseVcd(raw);
    expect(parsed.sampleRate).toBe(2_000_000);
    expect([...parsed.samples]).toEqual([0b00, 0b10]);
  });
});

describe("detectFormat", () => {
  it("uses the extension first", () => {
    expect(detectFormat("x.csv", "")).toBe("csv");
    expect(detectFormat("x.vcd", "")).toBe("vcd");
  });
  it("sniffs content when the extension is unknown", () => {
    expect(detectFormat("x.txt", "sample,time_s,D0\n0,0,1")).toBe("csv");
    expect(detectFormat("x.txt", "$timescale 1 ps $end")).toBe("vcd");
    expect(detectFormat("x.txt", "nonsense")).toBe(null);
  });
});

describe("parseCapture", () => {
  it("dispatches by format", () => {
    const buf = bufOf([1, 0], 1_000_000);
    expect([...parseCapture("csv", toCsv(buf, [0])).samples]).toEqual([1, 0]);
    expect([...parseCapture("vcd", toVcd(buf, [0])).samples]).toEqual([1, 0]);
  });
});

describe("import guards (malicious/corrupt input)", () => {
  const vcd = (lines: string[]) => lines.concat("").join("\n");

  it("rejects a VCD $comment declaring more samples than the cap", () => {
    expect(() =>
      parseVcd(
        vcd([
          "$timescale 1 ps $end",
          "$var wire 1 ! D0 $end",
          `$comment samplerate=1000000 samples=${MAX_SAMPLES + 1} $end`,
          "$enddefinitions $end",
          "#0",
          "1!",
        ]),
      ),
    ).toThrow(/import limit/i);
  });

  it("rejects a foreign VCD whose implied length exceeds the cap", () => {
    // Tiny GCD period (1 ps) with a huge final timestamp ⇒ billions of samples.
    expect(() =>
      parseVcd(
        vcd([
          "$timescale 1 ps $end",
          "$var wire 1 ! D0 $end",
          "$enddefinitions $end",
          "#1",
          "1!",
          `#${MAX_SAMPLES + 1}`,
          "0!",
        ]),
      ),
    ).toThrow(/import limit/i);
  });

  it("clamps an extreme sample rate so the period never divides by zero", () => {
    // samplerate 3e12 ⇒ round(1e12/rate) = 0; the period>=1 guard keeps the fill
    // loop from producing Infinity indices (which silently blanked the capture).
    const parsed = parseVcd(
      vcd([
        "$timescale 1 ps $end",
        "$var wire 1 ! D0 $end",
        "$comment samplerate=3000000000000 samples=5 $end",
        "$enddefinitions $end",
        "#0",
        "1!",
        "#1",
        "0!",
      ]),
    );
    expect([...parsed.samples]).toEqual([1, 0, 0, 0, 0]);
  });

  it("rejects a CSV header with more channel columns than channels", () => {
    const many = Array(CHANNEL_NAMES.length + 1)
      .fill("D0")
      .join(",");
    expect(() => parseCsv(`sample,time_s,${many}\n0,0,0`)).toThrow(
      /columns|supported/i,
    );
  });

  it("rateFromStep falls back to the default for an implausible sub-ps step", () => {
    expect(rateFromStep(0, 1e-20)).toBe(DEFAULT_RATE);
    expect(rateFromStep(0, 1e-6)).toBe(1_000_000); // a normal 1 MHz step
  });
});
