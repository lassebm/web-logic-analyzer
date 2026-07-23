import type { Decoder, DecoderContext, PinState, WaitInput } from "../types";
import { cond } from "../engine";
import { hex, isPrintable } from "../format";

const DATA = 0;

const ANN_RESET = 0;
const ANN_PRESENCE = 1;
const ANN_BIT = 2;
const ANN_BYTE = 3;
const ANN_WARN = 4;

/**
 * 1-Wire link-layer decoder. Classifies each low pulse by its duration:
 * a very long low is a reset; the low pulse right after a reset is the slave's
 * presence pulse; otherwise a short low is bit 1 and a long low is bit 0.
 * Bytes are assembled LSB-first. Works at normal and overdrive speeds.
 */
export const onewireDecoder: Decoder = {
  meta: {
    id: "onewire",
    name: "1-Wire",
    longname: "Dallas/Maxim 1-Wire",
    desc: "Single-wire bus (reset/presence + LSB-first bytes).",
    outputType: "byte",
    channels: [
      { id: "owr", name: "OWR", desc: "1-Wire data line", required: true },
    ],
    options: [
      {
        id: "speed",
        desc: "Bus speed",
        default: "standard",
        values: ["standard", "overdrive"],
      },
    ],
    annotations: [
      ["reset", "Reset"],
      ["presence", "Presence"],
      ["bit", "Bit"],
      ["byte", "Byte"],
      ["warning", "Warning"],
    ],
    annotationRows: [
      {
        id: "link",
        name: "Reset/Presence",
        classes: [ANN_RESET, ANN_PRESENCE],
      },
      { id: "bits", name: "Bits", classes: [ANN_BIT] },
      { id: "bytes", name: "Bytes", classes: [ANN_BYTE] },
      { id: "warnings", name: "Warnings", classes: [ANN_WARN] },
    ],
  },

  *decode(ctx: DecoderContext): Generator<WaitInput, void, PinState> {
    const overdrive = String(ctx.options.speed ?? "standard") === "overdrive";
    const us = (u: number) => Math.round((u * ctx.samplerate) / 1e6);

    // Duration thresholds (in samples).
    const resetThreshold = us(overdrive ? 48 : 300);
    const bitThreshold = us(overdrive ? 4 : 30);

    if (bitThreshold < 1) {
      ctx.put(0, 0, ANN_WARN, [
        "Sample rate too low for 1-Wire",
        "rate too low",
        "!",
      ]);
      return;
    }

    let bits = 0;
    let value = 0;
    let byteStart = 0;
    let expectPresence = false;

    while (true) {
      yield cond(DATA, "f"); // start of a low pulse
      const tf = ctx.samplenum;
      yield cond(DATA, "r"); // end of the low pulse
      const tr = ctx.samplenum;
      const low = tr - tf;

      if (low >= resetThreshold) {
        ctx.put(tf, tr, ANN_RESET, ["Reset", "Rst", "R"]);
        bits = 0;
        value = 0;
        expectPresence = true;
        continue;
      }

      if (expectPresence) {
        ctx.put(tf, tr, ANN_PRESENCE, ["Presence", "Pres", "P"]);
        expectPresence = false;
        bits = 0;
        value = 0;
        continue;
      }

      const bit = low < bitThreshold ? 1 : 0;
      if (bits === 0) byteStart = tf;
      ctx.put(tf, tr, ANN_BIT, [String(bit)]);
      value |= bit << bits; // LSB-first
      bits++;

      if (bits === 8) {
        const printable = isPrintable(value)
          ? ` '${String.fromCharCode(value)}'`
          : "";
        ctx.put(byteStart, tr, ANN_BYTE, [
          `${hex(value)}${printable}`,
          hex(value),
        ]);
        ctx.emit(byteStart, tr, "byte", { value });
        bits = 0;
        value = 0;
      }
    }
  },
};
