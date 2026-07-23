import type { Decoder, DecoderContext, PinState, WaitInput } from "../types";
import { cond } from "../engine";
import { hex, isPrintable } from "../format";

// Logical channels (declaration order).
const CLK = 0;
const MOSI = 1;
const MISO = 2;
const CS = 3;

// Annotation classes.
const ANN_MOSI = 0;
const ANN_MISO = 1;
const ANN_WARN = 2;

function formatWord(value: number, bits: number): string[] {
  const h = hex(value, Math.ceil(bits / 4));
  const bare = value.toString(16).toUpperCase();
  const display =
    bits === 8 && isPrintable(value)
      ? `${h} '${String.fromCharCode(value)}'`
      : h;
  // texts[1] is always the canonical 0x hex (matches other decoders).
  return [display, h, bare];
}

/**
 * SPI decoder. Samples MOSI and MISO on the clock edge selected by CPOL/CPHA,
 * assembles words of `word_size` bits, and (optionally) gates on chip-select.
 * Map unused data lines to any channel; set cs_polarity to "none" for 3-wire.
 */
export const spiDecoder: Decoder = {
  meta: {
    id: "spi",
    name: "SPI",
    longname: "Serial Peripheral Interface",
    desc: "Clocked serial bus (CLK, MOSI, MISO, CS).",
    outputType: "byte",
    channels: [
      { id: "clk", name: "CLK", desc: "Clock", required: true },
      {
        id: "mosi",
        name: "MOSI",
        desc: "Master out, slave in",
        required: true,
      },
      {
        id: "miso",
        name: "MISO",
        desc: "Master in, slave out",
        required: true,
      },
      { id: "cs", name: "CS#", desc: "Chip select", required: true },
    ],
    options: [
      { id: "cpol", desc: "Clock polarity (CPOL)", default: 0, values: [0, 1] },
      { id: "cpha", desc: "Clock phase (CPHA)", default: 0, values: [0, 1] },
      {
        id: "bit_order",
        desc: "Bit order",
        default: "msb-first",
        values: ["msb-first", "lsb-first"],
      },
      {
        id: "word_size",
        desc: "Word size (bits)",
        default: 8,
        values: [8, 16, 7, 9, 12],
      },
      {
        id: "cs_polarity",
        desc: "Chip select",
        default: "active-low",
        values: ["active-low", "active-high", "none"],
      },
    ],
    annotations: [
      ["mosi", "MOSI data"],
      ["miso", "MISO data"],
      ["warning", "Warning"],
    ],
    annotationRows: [
      { id: "mosi", name: "MOSI", classes: [ANN_MOSI] },
      { id: "miso", name: "MISO", classes: [ANN_MISO] },
      { id: "warnings", name: "Warnings", classes: [ANN_WARN] },
    ],
  },

  *decode(ctx: DecoderContext): Generator<WaitInput, void, PinState> {
    const cpol = Number(ctx.options.cpol) || 0;
    const cpha = Number(ctx.options.cpha) || 0;
    const msbFirst =
      String(ctx.options.bit_order ?? "msb-first") === "msb-first";
    const wordSize = Number(ctx.options.word_size) || 8;
    const csMode = String(ctx.options.cs_polarity ?? "active-low");

    // Sampling edge: leading edge is rising when CPOL=0. Sample on the leading
    // edge for CPHA=0, otherwise on the trailing edge.
    const leadingRising = cpol === 0;
    const sampleOnLeading = cpha === 0;
    const sampleRising = sampleOnLeading ? leadingRising : !leadingRising;
    const clkCode = sampleRising ? "r" : "f";

    const csActiveLevel = csMode === "active-high" ? 1 : 0;
    const csEnabled = csMode !== "none";

    let mosiVal = 0;
    let misoVal = 0;
    let bits = 0;
    let wordStart = 0;

    while (true) {
      yield cond(CLK, clkCode);

      if (csEnabled && ctx.pin(CS) !== csActiveLevel) {
        bits = 0;
        mosiVal = 0;
        misoVal = 0;
        continue;
      }

      const mBit = ctx.pin(MOSI);
      const sBit = ctx.pin(MISO);
      if (bits === 0) wordStart = ctx.samplenum;

      if (msbFirst) {
        mosiVal = (mosiVal << 1) | mBit;
        misoVal = (misoVal << 1) | sBit;
      } else {
        mosiVal |= mBit << bits;
        misoVal |= sBit << bits;
      }
      bits++;

      if (bits === wordSize) {
        const end = ctx.samplenum;
        ctx.put(wordStart, end, ANN_MOSI, formatWord(mosiVal, wordSize));
        ctx.put(wordStart, end, ANN_MISO, formatWord(misoVal, wordSize));
        // Stack byte packets from the MOSI stream (the typical command/data line).
        ctx.emit(wordStart, end, "byte", { value: mosiVal, line: "mosi" });
        bits = 0;
        mosiVal = 0;
        misoVal = 0;
      }
    }
  },
};
