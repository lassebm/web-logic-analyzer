// Shared builders for turning logical sample patterns into CaptureBuffers in
// tests. Protocol-specific encoding (SPI bit packing, CAN stuffing) stays in
// each decoder's test; this module owns the repeated plumbing — the run-length
// sample writer, the buffer-packing tail, the common UART frame shapes, and the
// I2C transaction builder shared by the i2c decoder and detection tests.
import { CaptureBuffer } from "../model/capture";

/**
 * Build a CaptureBuffer from per-sample byte values — 0/1 for a single channel,
 * or packed multi-channel bytes. Replaces the repeated
 * `new CaptureBuffer(rate, n); buf.append(new Uint8Array(samples))` tail.
 */
export function packLevels(
  sampleRate: number,
  samples: number[],
): CaptureBuffer {
  const buf = new CaptureBuffer(sampleRate, samples.length);
  buf.append(new Uint8Array(samples));
  return buf;
}

/**
 * Run-length sample writer: call `push(value, count)` to emit `count` samples of
 * `value` (rounded), and get back the flat level array. Keeps the loop-based
 * builder style while removing the duplicated push closure.
 */
export function runs(
  build: (push: (value: number, count: number) => void) => void,
): number[] {
  const out: number[] = [];
  build((value, count) => {
    for (let i = 0; i < Math.round(count); i++) out.push(value);
  });
  return out;
}

export interface UartFrameOpts {
  parity?: "none" | "odd" | "even";
  stopBits?: number;
  msb?: boolean;
  badStop?: boolean;
  badParity?: boolean;
}

/** Sample levels for one UART frame (idle high), `spb` samples per bit. */
export function uartFrameLevels(
  byte: number,
  spb: number,
  opts: UartFrameOpts = {},
): number[] {
  const {
    parity = "none",
    stopBits = 1,
    msb = false,
    badStop = false,
    badParity = false,
  } = opts;
  return runs((push) => {
    push(1, spb * 2); // idle
    push(0, spb); // start
    const bits: number[] = [];
    for (let i = 0; i < 8; i++)
      bits.push(msb ? (byte >> (7 - i)) & 1 : (byte >> i) & 1);
    for (const b of bits) push(b, spb);
    if (parity !== "none") {
      const ones = bits.filter((b) => b).length;
      let p = parity === "even" ? ones % 2 : 1 - (ones % 2);
      if (badParity) p ^= 1;
      push(p, spb);
    }
    push(badStop ? 0 : 1, spb * stopBits); // stop
    push(1, spb * 2); // idle
  });
}

/** A CaptureBuffer carrying one UART frame on channel 0. */
export function uartFrame(
  byte: number,
  spb: number,
  sampleRate: number,
  opts?: UartFrameOpts,
): CaptureBuffer {
  return packLevels(sampleRate, uartFrameLevels(byte, spb, opts));
}

export interface I2cOpts {
  /** Channel bit position for SCL (default 0). */
  sclBit?: number;
  /** Channel bit position for SDA (default 1). */
  sdaBit?: number;
  /** Samples per clock phase — SCL spends this long low, then this long high (default 6). */
  spb?: number;
  /** ACK bit clocked after each byte: 0 = ACK (default), 1 = NACK. */
  ack?: number;
}

/**
 * Sample levels for one I2C transaction on the given SCL/SDA bit positions:
 * idle, START, each byte MSB-first followed by an ACK/NACK, then STOP. `bytes[0]`
 * is the address byte (already `addr << 1 | rw`); the rest are data. Data is set
 * up while SCL is low and sampled on the SCL rising edge.
 */
export function i2cLevels(bytes: number[], opts: I2cOpts = {}): number[] {
  const { sclBit = 0, sdaBit = 1, spb = 6, ack = 0 } = opts;
  const pack = (scl: number, sda: number) => (scl << sclBit) | (sda << sdaBit);
  return runs((push) => {
    const clockBit = (bit: number) => {
      push(pack(0, bit), spb); // SCL low, set up SDA
      push(pack(1, bit), spb); // SCL high -> bit sampled
    };
    push(pack(1, 1), spb * 2); // idle: both high
    push(pack(1, 0), spb); // START: SDA falls while SCL high
    for (const b of bytes) {
      for (let i = 7; i >= 0; i--) clockBit((b >> i) & 1);
      clockBit(ack);
    }
    push(pack(0, 0), spb); // STOP setup: SCL low, SDA low
    push(pack(1, 0), spb); // SCL high, SDA still low
    push(pack(1, 1), spb); // SDA rises while SCL high
    push(pack(1, 1), spb * 2);
  });
}

/** A CaptureBuffer carrying back-to-back UART frames on channel 0 (8-N-1, LSB-first). */
export function uartBytes(
  bytes: number[],
  spb: number,
  sampleRate: number,
): CaptureBuffer {
  return packLevels(
    sampleRate,
    runs((push) => {
      push(1, spb * 3);
      for (const b of bytes) {
        push(0, spb);
        for (let i = 0; i < 8; i++) push((b >> i) & 1, spb);
        push(1, spb * 2);
      }
    }),
  );
}
