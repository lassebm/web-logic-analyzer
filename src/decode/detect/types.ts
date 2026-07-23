/**
 * Shared types for protocol auto-detection. Each detector (`./uart`, `./i2c`)
 * returns one of these; {@link ./index}'s `scanChannels` aggregates them and the
 * UI renders them generically by switching on `kind`.
 *
 * A detection is plain, serialisable data — no methods — so it stays pure and
 * unit-testable. The bridge from a detection to a concrete decoder instance is
 * {@link detectionToDecoder}, kept here (next to the types) rather than in the UI
 * so "how a detected signal becomes a decoder" lives with the detection model.
 */

export interface UartDetection {
  kind: "uart";
  /** The single channel the signal was found on. */
  channels: [number];
  /** Detected baud rate (a standard rate). */
  baudrate: number;
  /** Detected data bits (7, 8, or 9). */
  data_bits: number;
  /** Detected parity. */
  parity: "none" | "odd" | "even";
  /** Whether the line is inverted (idle-low). */
  invert: "no" | "yes";
  /** Number of frames decoded at the winning config. */
  frameCount: number;
  /** Clean-frame ratio in [0, 1]. */
  confidence: number;
}

export interface I2cDetection {
  kind: "i2c";
  /** The channel pair, ordered `[SCL, SDA]`. */
  channels: [number, number];
  /** Number of bytes (address + data) clocked out across the capture. */
  byteCount: number;
  /**
   * Confidence in [0, 1]: the fraction of SCL-high phases during which SDA held
   * steady — the defining I²C invariant (data is valid only while SCL is high).
   */
  confidence: number;
}

/** Any protocol detection. Discriminated by `kind`. */
export type Detection = UartDetection | I2cDetection;

/** Arguments for addDecoder that realise a detection as a decoder instance. */
export interface DecoderSpec {
  decoderId: string;
  channelMap: number[];
  options: Record<string, string | number>;
}

/** Map a detection to the decoder instance the user would add for it. */
export function detectionToDecoder(d: Detection): DecoderSpec {
  switch (d.kind) {
    case "uart":
      return {
        decoderId: "uart",
        channelMap: [d.channels[0]],
        options: {
          baudrate: d.baudrate,
          data_bits: d.data_bits,
          parity: d.parity,
          invert: d.invert,
        },
      };
    case "i2c":
      // The i2c decoder's channels are declared [SCL, SDA] — same order we store.
      return {
        decoderId: "i2c",
        channelMap: [d.channels[0], d.channels[1]],
        options: {},
      };
  }
}
