import { describe, expect, it } from "vitest";
import { formatSampleCount } from "./format";

describe("formatSampleCount", () => {
  it("shows counts below 1000 verbatim", () => {
    expect(formatSampleCount(0)).toBe("0");
    expect(formatSampleCount(999)).toBe("999");
  });

  it("uses k for thousands and M for millions", () => {
    expect(formatSampleCount(10_000)).toBe("10 k");
    expect(formatSampleCount(100_000)).toBe("100 k");
    expect(formatSampleCount(1_000_000)).toBe("1 M");
    expect(formatSampleCount(5_000_000)).toBe("5 M");
    expect(formatSampleCount(100_000_000)).toBe("100 M");
    expect(formatSampleCount(1_000_000_000)).toBe("1 G");
  });

  it("abbreviates with decimals when they are exact", () => {
    expect(formatSampleCount(1_500_000)).toBe("1.5 M");
    expect(formatSampleCount(1_250_000)).toBe("1.25 M");
    expect(formatSampleCount(12_500)).toBe("12.5 k");
  });

  // These are values the user picks from a list and gets literally, so a
  // rounded label would name a count the device can't capture: 4096 samples is
  // not "4.1 k". Every SUMP device reports a binary buffer depth, so this is
  // the common case there, not an edge case.
  it("writes out a count two decimals cannot express exactly", () => {
    expect(formatSampleCount(4096)).toBe((4096).toLocaleString());
    expect(formatSampleCount(262_144)).toBe((262_144).toLocaleString());
    expect(formatSampleCount(1_048_576)).toBe((1_048_576).toLocaleString());
    expect(formatSampleCount(1_234_567)).toBe((1_234_567).toLocaleString());
  });

  it("never abbreviates a count it would have to round", () => {
    for (const n of [1024, 4096, 16_384, 65_536, 262_144, 24_576]) {
      expect(formatSampleCount(n)).not.toMatch(/[kMG]$/);
    }
  });
});
