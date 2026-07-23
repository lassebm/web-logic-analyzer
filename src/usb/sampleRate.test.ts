import { describe, expect, it } from "vitest";
import {
  encodeSampleRate,
  SAMPLE_RATES,
  formatSampleRate,
  bandwidthWarning,
} from "./sampleRate";
import {
  CMD_START_FLAGS_CLK_30MHZ,
  CMD_START_FLAGS_CLK_48MHZ,
} from "./constants";

describe("encodeSampleRate", () => {
  it("encodes 24 MHz on the 48 MHz clock with delay 1", () => {
    const c = encodeSampleRate(24_000_000);
    expect(c.baseClock).toBe(48_000_000);
    expect(c.delay).toBe(1);
    expect(c.flags & CMD_START_FLAGS_CLK_48MHZ).toBe(CMD_START_FLAGS_CLK_48MHZ);
    expect(c.sampleDelayH).toBe(0);
    expect(c.sampleDelayL).toBe(1);
  });

  it("encodes 1 MHz on the 48 MHz clock with delay 47", () => {
    const c = encodeSampleRate(1_000_000);
    expect(c.baseClock).toBe(48_000_000);
    expect(c.delay).toBe(47);
  });

  it("falls back to the 30 MHz clock for 20 kHz (48 MHz delay exceeds max)", () => {
    const c = encodeSampleRate(20_000);
    expect(c.baseClock).toBe(30_000_000);
    expect(c.delay).toBe(1499);
    expect(c.flags & CMD_START_FLAGS_CLK_48MHZ).toBe(CMD_START_FLAGS_CLK_30MHZ); // i.e. 0
    expect(c.sampleDelayH).toBe(5);
    expect(c.sampleDelayL).toBe(219);
  });

  it("can encode every advertised sample rate", () => {
    for (const r of SAMPLE_RATES) {
      expect(() => encodeSampleRate(r)).not.toThrow();
    }
  });

  it("rejects an unachievable rate", () => {
    expect(() => encodeSampleRate(7_000)).toThrow();
  });
});

describe("sample-rate helpers", () => {
  it("formats human-readable rates", () => {
    expect(formatSampleRate(24_000_000)).toBe("24 MHz");
    expect(formatSampleRate(500_000)).toBe("500 kHz");
    expect(formatSampleRate(20_000)).toBe("20 kHz");
  });

  it("warns only when throughput exceeds the sustainable ceiling", () => {
    expect(bandwidthWarning(24_000_000)).toBeNull(); // 24 MB/s is fine
    expect(bandwidthWarning(24_000_000, true)).not.toBeNull(); // 48 MB/s (16-bit) is not
  });
});
