import { describe, expect, it } from "vitest";
import { runDecoder } from "./engine";
import { uartDecoder } from "./decoders/uart";
import {
  packLevels,
  uartBytes,
  uartFrame,
  uartFrameLevels,
} from "../test/waveforms";

const ANN_DATA = 6;
const ANN_FRAME_ERR = 5;
const ANN_PARITY_ERR = 4;

describe("uart decoder", () => {
  const sr = 1_000_000;
  const baud = 100_000; // 10 samples/bit

  it("decodes a single byte (8-N-1, LSB-first)", () => {
    const buf = uartFrame(0x41, sr / baud, sr);
    const { annotations: anns } = runDecoder(uartDecoder, buf, [0], {
      baudrate: baud,
      data_bits: 8,
      parity: "none",
      stop_bits: 1,
      bit_order: "lsb-first",
      invert: "no",
    });

    const dataAnns = anns.filter((a) => a.annClass === ANN_DATA);
    expect(dataAnns.length).toBe(1);
    expect(dataAnns[0].texts).toContain("0x41");
  });

  it("decodes several bytes in sequence", () => {
    const sampleRate = 2_000_000;
    const rate = 115200;
    // Concatenated frames for 'H','i'.
    const buf = uartBytes([0x48, 0x69], sampleRate / rate, sampleRate);

    const { annotations: anns } = runDecoder(uartDecoder, buf, [0], {
      baudrate: rate,
      data_bits: 8,
    });
    const values = anns
      .filter((a) => a.annClass === ANN_DATA)
      .map((a) => a.texts[1]);
    expect(values).toEqual(["0x48", "0x69"]);
  });

  it("decodes with even parity and no parity error", () => {
    const buf = uartFrame(0x41, sr / baud, sr, { parity: "even" });
    const { annotations } = runDecoder(uartDecoder, buf, [0], {
      baudrate: baud,
      parity: "even",
    });
    expect(
      annotations.filter((a) => a.annClass === ANN_DATA)[0].texts,
    ).toContain("0x41");
    expect(annotations.some((a) => a.annClass === ANN_PARITY_ERR)).toBe(false);
  });

  it("flags a parity error", () => {
    const buf = uartFrame(0x41, sr / baud, sr, {
      parity: "even",
      badParity: true,
    });
    const { annotations } = runDecoder(uartDecoder, buf, [0], {
      baudrate: baud,
      parity: "even",
    });
    expect(annotations.some((a) => a.annClass === ANN_PARITY_ERR)).toBe(true);
  });

  it("flags a framing error on a bad stop bit", () => {
    const buf = uartFrame(0x41, sr / baud, sr, { badStop: true });
    const { annotations } = runDecoder(uartDecoder, buf, [0], {
      baudrate: baud,
    });
    expect(annotations.some((a) => a.annClass === ANN_FRAME_ERR)).toBe(true);
  });

  it("decodes MSB-first", () => {
    const buf = uartFrame(0xb2, sr / baud, sr, { msb: true });
    const { annotations } = runDecoder(uartDecoder, buf, [0], {
      baudrate: baud,
      bit_order: "msb-first",
    });
    expect(
      annotations.filter((a) => a.annClass === ANN_DATA)[0].texts,
    ).toContain("0xB2");
  });

  it("decodes an inverted signal (idle low, start bit high)", () => {
    // Flip every level of the normal (idle-high) frame: idle -> low, start -> high.
    const inverted = uartFrameLevels(0x41, sr / baud).map((v) => 1 - v);
    const buf = packLevels(sr, inverted);
    const { annotations } = runDecoder(uartDecoder, buf, [0], {
      baudrate: baud,
      data_bits: 8,
      invert: "yes",
    });
    expect(
      annotations.filter((a) => a.annClass === ANN_DATA)[0].texts,
    ).toContain("0x41");
    expect(annotations.some((a) => a.annClass === ANN_FRAME_ERR)).toBe(false);
  });
});
