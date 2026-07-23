import { describe, expect, it } from "vitest";
import {
  sampleToX,
  xToSample,
  niceTimeStep,
  formatTime,
  type WaveView,
} from "./renderer";

const view: WaveView = { viewStart: 100, samplesPerPixel: 2 };

describe("renderer coordinate mapping", () => {
  it("maps samples to pixels", () => {
    expect(sampleToX(100, view)).toBe(0);
    expect(sampleToX(110, view)).toBe(5);
  });

  it("maps pixels to samples", () => {
    expect(xToSample(0, view)).toBe(100);
    expect(xToSample(5, view)).toBe(110);
  });

  it("round-trips", () => {
    for (const s of [100, 137, 250, 999]) {
      expect(xToSample(sampleToX(s, view), view)).toBeCloseTo(s, 6);
    }
  });
});

describe("time ruler helpers", () => {
  it("rounds to nice 1/2/5 x 10ⁿ steps", () => {
    expect(niceTimeStep(1)).toBe(1);
    expect(niceTimeStep(1.2)).toBe(1);
    expect(niceTimeStep(3)).toBe(2);
    expect(niceTimeStep(6)).toBe(5);
    expect(niceTimeStep(9)).toBe(10);
    expect(niceTimeStep(0.0000012)).toBeCloseTo(0.000001, 12); // ~1 µs
  });

  it("formats time offsets with sensible units and sign", () => {
    expect(formatTime(0)).toBe("0");
    expect(formatTime(0.001)).toBe("1 ms");
    expect(formatTime(0.0000015)).toBe("1.5 µs");
    expect(formatTime(-0.000001)).toBe("-1 µs");
    expect(formatTime(2)).toBe("2 s");
  });
});
