import { describe, expect, it } from "vitest";
import { scanChannels } from "./index";
import { i2cLevels, packLevels, uartFrameLevels } from "../../test/waveforms";

const I2C_BYTES = [(0x50 << 1) | 0, 0xab, 0xcd];

describe("scanChannels", () => {
  it("returns UART hits sorted by channel and skips silent lines", () => {
    const sampleRate = 1_000_000;
    const baud = 115200;
    const levels: number[] = [];
    for (const b of [0x55, 0x41, 0x0d, 0x0a, 0x48])
      levels.push(...uartFrameLevels(b, sampleRate / baud));
    // UART on channel 2 only; channels 0/1 idle low.
    const buf = packLevels(
      sampleRate,
      levels.map((v) => v << 2),
    );
    const hits = scanChannels(buf, [0, 1, 2]);
    expect(hits).toHaveLength(1);
    expect(hits[0].kind).toBe("uart");
    expect(hits[0].channels).toEqual([2]);
  });

  it("detects I²C on a pair and resolves SCL/SDA regardless of wiring order", () => {
    // SDA on the lower channel, SCL on the higher one.
    const buf = packLevels(
      1_000_000,
      i2cLevels(I2C_BYTES, { sclBit: 3, sdaBit: 1 }),
    );
    const hits = scanChannels(buf, [1, 3]);
    expect(hits).toHaveLength(1);
    expect(hits[0].kind).toBe("i2c");
    // Reported [SCL, SDA] = [3, 1], not the pair-iteration order [1, 3].
    expect(hits[0].channels).toEqual([3, 1]);
  });

  it("reports UART and I²C together, sorted by first channel", () => {
    const sampleRate = 1_000_000;
    const baud = 115200;
    const spb = sampleRate / baud;

    const i2c = i2cLevels(I2C_BYTES, { sclBit: 0, sdaBit: 1 }); // ch 0 SCL + 1 SDA
    const uart: number[] = [];
    for (const b of [0x48, 0x69, 0x2e, 0x0a])
      uart.push(...uartFrameLevels(b, spb)); // channel 4

    // Merge into one buffer, padding each source with its idle level.
    const len = Math.max(i2c.length, uart.length);
    const merged: number[] = [];
    for (let i = 0; i < len; i++) {
      const busBits = i2c[i] ?? 0b11; // I²C idle: SCL + SDA high
      const uartBit = (uart[i] ?? 1) << 4; // UART idle high
      merged.push(busBits | uartBit);
    }
    const buf = packLevels(sampleRate, merged);

    const hits = scanChannels(buf, [0, 1, 4]);
    expect(hits.map((h) => h.kind)).toEqual(["i2c", "uart"]);
    expect(hits[0].channels).toEqual([0, 1]);
    expect(hits[1].channels).toEqual([4]);
  });
});
