import { describe, expect, it } from "vitest";
import { detectI2c } from "./i2c";
import { i2cLevels, packLevels, runs } from "../../test/waveforms";

const BYTES = [(0x50 << 1) | 0, 0xab, 0xcd]; // write to 0x50, two data bytes

describe("detectI2c", () => {
  it("detects an I²C bus and reports the [SCL, SDA] pair", () => {
    const buf = packLevels(
      1_000_000,
      i2cLevels(BYTES, { sclBit: 0, sdaBit: 1 }),
    );
    const d = detectI2c(buf, 0, 1);
    expect(d).not.toBeNull();
    expect(d!.kind).toBe("i2c");
    expect(d!.channels).toEqual([0, 1]);
    expect(d!.byteCount).toBe(3);
    expect(d!.confidence).toBeGreaterThan(0.8);
  });

  it("rejects the swapped orientation (SDA is not a clock)", () => {
    const buf = packLevels(
      1_000_000,
      i2cLevels(BYTES, { sclBit: 0, sdaBit: 1 }),
    );
    // Real SCL is channel 0; asking to treat channel 1 as the clock must fail,
    // since the true clock toggles freely during the data line's high phases.
    expect(detectI2c(buf, 1, 0)).toBeNull();
  });

  it("works on arbitrary channel positions", () => {
    const buf = packLevels(
      1_000_000,
      i2cLevels(BYTES, { sclBit: 5, sdaBit: 2 }),
    );
    const d = detectI2c(buf, 5, 2);
    expect(d).not.toBeNull();
    expect(d!.channels).toEqual([5, 2]);
  });

  it("returns null for a clock with a static data line (no transactions)", () => {
    // SCL toggles; SDA held high the whole time — no START, nothing framed.
    const buf = packLevels(
      1_000_000,
      runs((push) => {
        for (let i = 0; i < 200; i++) {
          push(0b10, 6); // scl=0, sda=1
          push(0b11, 6); // scl=1, sda=1
        }
      }),
    );
    expect(detectI2c(buf, 0, 1)).toBeNull();
  });

  it("rejects an unrelated clock + data pair (SDA edges land while SCL is high)", () => {
    // A mostly-high "clock" paired with an independent data line: the pair can
    // squeak past the per-high-phase stability check (one long high phase), but
    // most SDA edges fall while SCL is high — which must disqualify it.
    const packed: number[] = [];
    for (let t = 0; t < 3000; t++) {
      const scl = t % 25 < 20 ? 1 : 0; // high 80% of the time
      const sda = Math.floor(t / 13) % 2; // toggles on its own schedule
      packed.push(scl | (sda << 1));
    }
    const buf = packLevels(1_000_000, packed);
    expect(detectI2c(buf, 0, 1)).toBeNull();
    expect(detectI2c(buf, 1, 0)).toBeNull();
  });

  it("returns null when SCL and SDA are the same channel", () => {
    const buf = packLevels(
      1_000_000,
      i2cLevels(BYTES, { sclBit: 0, sdaBit: 1 }),
    );
    expect(detectI2c(buf, 0, 0)).toBeNull();
  });
});
