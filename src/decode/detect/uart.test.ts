import { describe, expect, it } from "vitest";
import { detectUart } from "./uart";
import {
  packLevels,
  runs,
  uartBytes,
  uartFrameLevels,
  type UartFrameOpts,
} from "../../test/waveforms";

/** Concatenate several UART frames (idle-high) into one flat level array. */
function manyFrames(
  bytes: number[],
  spb: number,
  opts?: UartFrameOpts,
): number[] {
  const levels: number[] = [];
  for (const b of bytes) levels.push(...uartFrameLevels(b, spb, opts));
  return levels;
}

const BYTES = [0x55, 0x41, 0x0d, 0x0a, 0x48, 0x69, 0x2e];

describe("detectUart", () => {
  it("recovers baud + 8-N-1 across sample-rate / baud pairs", () => {
    const cases = [
      { sampleRate: 1_000_000, baud: 115200 },
      { sampleRate: 2_000_000, baud: 9600 },
      { sampleRate: 12_000_000, baud: 921600 },
    ];
    for (const { sampleRate, baud } of cases) {
      const buf = uartBytes(BYTES, sampleRate / baud, sampleRate);
      const d = detectUart(buf, 0);
      expect(d, `${sampleRate}@${baud}`).not.toBeNull();
      expect(d!.kind).toBe("uart");
      expect(d!.baudrate).toBe(baud);
      expect(d!.data_bits).toBe(8);
      expect(d!.parity).toBe("none");
      expect(d!.invert).toBe("no");
      expect(d!.frameCount).toBe(BYTES.length);
      expect(d!.confidence).toBeGreaterThan(0.9);
    }
  });

  it("detects even parity", () => {
    const sampleRate = 1_000_000;
    const baud = 115200;
    const levels = manyFrames(BYTES, sampleRate / baud, {
      parity: "even",
    });
    const d = detectUart(packLevels(sampleRate, levels), 0);
    expect(d).not.toBeNull();
    expect(d!.baudrate).toBe(baud);
    expect(d!.parity).toBe("even");
    // 8-E-1 and 9-N-1 look identical on the wire; the common reading must win.
    expect(d!.data_bits).toBe(8);
  });

  it("detects an inverted (idle-low) line", () => {
    const sampleRate = 1_000_000;
    const baud = 115200;
    const normal = manyFrames(BYTES, sampleRate / baud);
    const inverted = normal.map((v) => v ^ 1);
    const d = detectUart(packLevels(sampleRate, inverted), 0);
    expect(d).not.toBeNull();
    expect(d!.baudrate).toBe(baud);
    expect(d!.invert).toBe("yes");
  });

  it("returns null for an idle (static) line", () => {
    const buf = packLevels(
      1_000_000,
      runs((push) => push(1, 5000)),
    );
    expect(detectUart(buf, 0)).toBeNull();
  });

  it("returns null for a plain clock (non-UART) signal", () => {
    // Square wave: toggles every 10 samples, no serial framing.
    const buf = packLevels(
      1_000_000,
      runs((push) => {
        for (let i = 0; i < 200; i++) {
          push(1, 10);
          push(0, 10);
        }
      }),
    );
    expect(detectUart(buf, 0)).toBeNull();
  });

  it("returns null when the sample rate is too low to frame", () => {
    // ~3 samples/bit — below the usable threshold; must not guess a baud.
    const sampleRate = 345_600; // 3x 115200
    const buf = uartBytes(BYTES, sampleRate / 115200, sampleRate);
    expect(detectUart(buf, 0)).toBeNull();
  });

  it("detects on a non-zero channel", () => {
    const sampleRate = 1_000_000;
    const baud = 115200;
    const levels = manyFrames(BYTES, sampleRate / baud);
    // Shift the single-channel levels onto channel 3.
    const buf = packLevels(
      sampleRate,
      levels.map((v) => v << 3),
    );
    const d = detectUart(buf, 3);
    expect(d).not.toBeNull();
    expect(d!.channels).toEqual([3]);
    expect(d!.baudrate).toBe(baud);
  });
});
