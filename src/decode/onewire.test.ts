import { describe, expect, it } from "vitest";
import { CaptureBuffer } from "../model/capture";
import { runDecoder } from "./engine";
import { onewireDecoder } from "./decoders/onewire";
import { packLevels, runs } from "../test/waveforms";

const ANN_RESET = 0;
const ANN_PRESENCE = 1;
const ANN_BYTE = 3;

/**
 * Build a 1-Wire transaction at 1 MHz (1 sample/µs): reset, presence, then one
 * byte transmitted LSB-first. Short low = 1, long low = 0.
 */
function buildOneWire(byte: number): CaptureBuffer {
  const SLOT = 70;
  const levels = runs((push) => {
    push(1, 100); // idle
    push(0, 500); // reset (>= 300µs)
    push(1, 50); // recovery
    push(0, 120); // presence pulse
    push(1, 50);

    for (let i = 0; i < 8; i++) {
      const low = (byte >> i) & 1 ? 5 : 60; // short=1, long=0
      push(0, low);
      push(1, SLOT - low);
    }
    push(1, 100);
  });

  return packLevels(1_000_000, levels);
}

describe("1-wire decoder", () => {
  it("decodes reset, presence, and a byte (LSB-first)", () => {
    const buf = buildOneWire(0x33); // READ ROM command
    const { annotations, packets } = runDecoder(onewireDecoder, buf, [0], {
      speed: "standard",
    });

    expect(annotations.some((a) => a.annClass === ANN_RESET)).toBe(true);
    expect(annotations.some((a) => a.annClass === ANN_PRESENCE)).toBe(true);

    const bytes = annotations.filter((a) => a.annClass === ANN_BYTE);
    expect(bytes.length).toBe(1);
    expect(bytes[0].texts[1]).toBe("0x33");

    // Emits a stackable byte packet.
    expect(packets.map((p) => (p.data as { value: number }).value)).toEqual([
      0x33,
    ]);
  });
});
