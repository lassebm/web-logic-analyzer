import { describe, expect, it } from "vitest";
import { CaptureBuffer } from "../model/capture";
import { runDecoder } from "./engine";
import { i2cDecoder } from "./decoders/i2c";
import { packLevels, runs } from "../test/waveforms";

const ANN_START = 0;
const ANN_STOP = 1;
const ANN_ADDR = 2;
const ANN_DATA = 3;
const ANN_ACK = 4;

// scl=D0, sda=D1
function pack(scl: number, sda: number): number {
  return scl | (sda << 1);
}

/**
 * Build: START, address (7-bit + R/W), ACK, one data byte, ACK, STOP.
 * All bytes MSB-first, SDA sampled on SCL rising.
 */
function buildI2c(
  addr7: number,
  read: boolean,
  dataByte: number,
  dataAck = 0,
  spb = 4,
): CaptureBuffer {
  const samples = runs((push) => {
    const clockByte = (value: number) => {
      for (let i = 7; i >= 0; i--) {
        const bit = (value >> i) & 1;
        push(pack(0, bit), spb); // SCL low, SDA set up
        push(pack(1, bit), spb); // SCL high -> sampled
      }
    };
    const ack = (bit: number) => {
      push(pack(0, bit), spb); // SCL low, SDA = ACK(0)/NACK(1)
      push(pack(1, bit), spb); // SCL high -> sampled
    };

    push(pack(1, 1), spb * 2); // idle: SCL high, SDA high
    push(pack(1, 0), spb); // START: SDA falls while SCL high

    clockByte((addr7 << 1) | (read ? 1 : 0));
    ack(0);
    clockByte(dataByte);
    ack(dataAck);

    // STOP: SCL low, then SCL high with SDA low, then SDA rises while SCL high.
    push(pack(0, 0), spb);
    push(pack(1, 0), spb);
    push(pack(1, 1), spb);
    push(pack(1, 1), spb * 2);
  });

  return packLevels(1_000_000, samples);
}

describe("i2c decoder", () => {
  it("decodes start, address+W, data, acks, and stop", () => {
    const buf = buildI2c(0x50, false, 0xab);
    const { annotations: anns } = runDecoder(i2cDecoder, buf, [0, 1], {
      addr_format: "7-bit",
    });

    expect(anns.some((a) => a.annClass === ANN_START)).toBe(true);
    expect(anns.some((a) => a.annClass === ANN_STOP)).toBe(true);

    const addr = anns.filter((a) => a.annClass === ANN_ADDR);
    expect(addr.length).toBe(1);
    expect(addr[0].texts[0]).toBe("0x50 W");

    const data = anns.filter((a) => a.annClass === ANN_DATA);
    expect(data.map((a) => a.texts[1])).toContain("0xAB");

    // Two ACKs (address + data).
    expect(anns.filter((a) => a.annClass === ANN_ACK).length).toBe(2);
  });

  it("marks a read address", () => {
    const buf = buildI2c(0x3a, true, 0x00);
    const { annotations: anns } = runDecoder(i2cDecoder, buf, [0, 1], {});
    const addr = anns.filter((a) => a.annClass === ANN_ADDR);
    expect(addr[0].texts[0]).toBe("0x3A R");
  });

  it("reports a NACK on the data byte", () => {
    const ANN_NACK = 5;
    const buf = buildI2c(0x50, true, 0xff, 1); // data NACKed
    const { annotations: anns } = runDecoder(i2cDecoder, buf, [0, 1], {});
    expect(anns.some((a) => a.annClass === ANN_NACK)).toBe(true);
    // Exactly one ACK (the address) and one NACK (the data).
    expect(anns.filter((a) => a.annClass === ANN_ACK).length).toBe(1);
  });
});
