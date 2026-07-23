import { beforeEach, describe, expect, it } from "vitest";
import { get } from "svelte/store";
import {
  captureBuffer,
  config,
  decoders,
  detections,
  runDetection,
} from "./session";
import { defaultConfig } from "../test/fixtures";
import { i2cLevels, packLevels, uartBytes } from "../test/waveforms";

const SR = 1_000_000;
const BAUD = 115200;
const BYTES = [0x55, 0x41, 0x0d, 0x0a, 0x48, 0x69, 0x2e];

beforeEach(() => {
  captureBuffer.set(null);
  detections.set(null);
  decoders.set([]);
  config.set(defaultConfig());
});

describe("runDetection", () => {
  it("clears results (no-op) when there is no capture", () => {
    detections.set([]);
    runDetection();
    expect(get(detections)).toBeNull();
  });

  it("detects a UART line on an active channel", () => {
    captureBuffer.set(uartBytes(BYTES, SR / BAUD, SR));
    runDetection();
    const hits = get(detections);
    expect(hits).not.toBeNull();
    expect(hits!.length).toBe(1);
    const h = hits![0];
    expect(h.kind).toBe("uart");
    if (h.kind !== "uart") throw new Error("expected UART");
    expect(h.channels).toEqual([0]);
    expect(h.baudrate).toBe(BAUD);
    expect(h.data_bits).toBe(8);
  });

  it("detects an I²C bus on a channel pair", () => {
    // SCL on channel 0, SDA on channel 1.
    captureBuffer.set(packLevels(SR, i2cLevels([(0x50 << 1) | 0, 0xab, 0xcd])));
    runDetection();
    const hits = get(detections);
    expect(hits!.length).toBe(1);
    const h = hits![0];
    expect(h.kind).toBe("i2c");
    if (h.kind !== "i2c") throw new Error("expected I²C");
    expect(h.channels).toEqual([0, 1]);
  });

  it("skips channels the user has disabled", () => {
    captureBuffer.set(uartBytes(BYTES, SR / BAUD, SR)); // UART on channel 0
    config.update((c) => ({
      ...c,
      enabledChannels: c.enabledChannels.map((_, i) => i !== 0), // disable ch0
    }));
    runDetection();
    expect(get(detections)).toEqual([]); // scanned, nothing on the other channels
  });
});
