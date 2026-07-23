import { describe, expect, it } from "vitest";
import { CaptureBuffer } from "../model/capture";
import { runDecoder } from "./engine";
import { spiDecoder } from "./decoders/spi";
import { packLevels, runs } from "../test/waveforms";

const ANN_MOSI = 0;
const ANN_MISO = 1;

// clk=D0, mosi=D1, miso=D2, cs=D3
function pack(clk: number, mosi: number, miso: number, cs: number): number {
  return clk | (mosi << 1) | (miso << 2) | (cs << 3);
}

/** Build a mode-0 (CPOL0/CPHA0), MSB-first, CS-active-low SPI transfer. */
function buildSpi(mosiByte: number, misoByte: number, spb = 4): CaptureBuffer {
  const samples = runs((push) => {
    push(pack(0, 0, 0, 1), spb * 2); // idle, CS high
    push(pack(0, 0, 0, 0), spb); // assert CS

    for (let i = 7; i >= 0; i--) {
      const m = (mosiByte >> i) & 1;
      const s = (misoByte >> i) & 1;
      push(pack(0, m, s, 0), spb); // clock low, data set up
      push(pack(1, m, s, 0), spb); // clock high -> sampled on rising edge
    }

    push(pack(0, 0, 0, 0), spb);
    push(pack(0, 0, 0, 1), spb * 2); // deassert CS
  });

  return packLevels(1_000_000, samples);
}

describe("spi decoder", () => {
  it("decodes MOSI and MISO bytes in mode 0, MSB-first", () => {
    const buf = buildSpi(0xa5, 0x3c);
    const { annotations: anns } = runDecoder(spiDecoder, buf, [0, 1, 2, 3], {
      cpol: 0,
      cpha: 0,
      bit_order: "msb-first",
      word_size: 8,
      cs_polarity: "active-low",
    });

    const mosi = anns.filter((a) => a.annClass === ANN_MOSI);
    const miso = anns.filter((a) => a.annClass === ANN_MISO);
    expect(mosi.map((a) => a.texts[1])).toContain("0xA5");
    expect(miso.map((a) => a.texts[1])).toContain("0x3C");
  });

  it("honours LSB-first bit order", () => {
    // Same wire pattern; MSB-first reads 0xB2, LSB-first reads its bit-reversal 0x4D.
    const buf = buildSpi(0xb2, 0x00);
    const msb = runDecoder(spiDecoder, buf, [0, 1, 2, 3], {
      bit_order: "msb-first",
    }).annotations;
    const lsb = runDecoder(spiDecoder, buf, [0, 1, 2, 3], {
      bit_order: "lsb-first",
    }).annotations;
    expect(msb.filter((a) => a.annClass === ANN_MOSI)[0].texts).toContain(
      "0xB2",
    );
    expect(lsb.filter((a) => a.annClass === ANN_MOSI)[0].texts).toContain(
      "0x4D",
    );
  });

  it("samples on the trailing edge in mode 1 (CPOL=0, CPHA=1)", () => {
    const spb = 4;
    const byte = 0x5a;
    const buf = packLevels(
      1_000_000,
      runs((push) => {
        push(pack(0, 0, 0, 1), spb * 2); // idle, CS high
        push(pack(0, 0, 0, 0), spb); // assert CS, clock idle low
        for (let i = 7; i >= 0; i--) {
          const bit = (byte >> i) & 1;
          push(pack(1, bit, 0, 0), spb); // rising (leading, not sampled)
          push(pack(0, bit, 0, 0), spb); // falling (trailing, sampled)
        }
        push(pack(0, 0, 0, 1), spb * 2);
      }),
    );

    const anns = runDecoder(spiDecoder, buf, [0, 1, 2, 3], {
      cpol: 0,
      cpha: 1,
    }).annotations;
    expect(anns.filter((a) => a.annClass === ANN_MOSI)[0].texts).toContain(
      "0x5A",
    );
  });

  it("does not decode while CS is deasserted", () => {
    // CS never asserted -> no words.
    const samples: number[] = [];
    for (let i = 0; i < 40; i++) samples.push(pack(i % 2, 1, 0, 1)); // toggling clock, CS high
    const buf = new CaptureBuffer(1_000_000, samples.length);
    buf.append(new Uint8Array(samples));
    const { annotations: anns } = runDecoder(spiDecoder, buf, [0, 1, 2, 3], {
      cs_polarity: "active-low",
    });
    expect(anns.filter((a) => a.annClass === ANN_MOSI).length).toBe(0);
  });
});
