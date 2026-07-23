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
  });

  it("keeps up to two decimals for non-round values, trimming zeros", () => {
    expect(formatSampleCount(1_500_000)).toBe("1.5 M");
    expect(formatSampleCount(1_234_567)).toBe("1.23 M");
    expect(formatSampleCount(1_000_000_000)).toBe("1 G");
  });
});
