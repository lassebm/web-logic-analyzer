import type { Decoder, DecoderContext, PinState, WaitInput } from "../types";
import { hex, isPrintable } from "../format";

// Logical channels.
const SCL = 0;
const SDA = 1;

// Annotation classes.
const ANN_START = 0;
const ANN_STOP = 1;
const ANN_ADDR = 2;
const ANN_DATA = 3;
const ANN_ACK = 4;
const ANN_NACK = 5;

// OR-matched wait conditions (indices used with ctx.matched).
// Index 0 = SCL rising (sample a bit) is handled as the fall-through case.
const COND_START = 1; // SDA falling while SCL high: (repeated) start
const COND_STOP = 2; // SDA rising while SCL high: stop

/**
 * I2C decoder. Tracks START/STOP (including repeated start), decodes the
 * address byte (7-bit address + R/W) and subsequent data bytes, and reports
 * ACK/NACK on the 9th clock. SDA is sampled on the rising edge of SCL.
 */
export const i2cDecoder: Decoder = {
  meta: {
    id: "i2c",
    name: "I²C",
    longname: "Inter-Integrated Circuit",
    desc: "Two-wire bus (SCL, SDA).",
    outputType: "byte",
    channels: [
      { id: "scl", name: "SCL", desc: "Serial clock", required: true },
      { id: "sda", name: "SDA", desc: "Serial data", required: true },
    ],
    options: [
      {
        id: "addr_format",
        desc: "Address display",
        default: "7-bit",
        values: ["7-bit", "8-bit"],
      },
    ],
    annotations: [
      ["start", "Start"],
      ["stop", "Stop"],
      ["address", "Address + R/W"],
      ["data", "Data byte"],
      ["ack", "ACK"],
      ["nack", "NACK"],
    ],
    annotationRows: [
      { id: "frame", name: "Start/Stop", classes: [ANN_START, ANN_STOP] },
      { id: "bytes", name: "Address/Data", classes: [ANN_ADDR, ANN_DATA] },
      { id: "ack", name: "ACK/NACK", classes: [ANN_ACK, ANN_NACK] },
    ],
  },

  *decode(ctx: DecoderContext): Generator<WaitInput, void, PinState> {
    const eightBit = String(ctx.options.addr_format ?? "7-bit") === "8-bit";

    const conditions: WaitInput = [
      { [SCL]: "r" },
      { [SDA]: "f", [SCL]: "h" },
      { [SDA]: "r", [SCL]: "h" },
    ];

    let inFrame = false;
    let isAddressByte = false;
    let bits = 0;
    let value = 0;
    let byteStart = 0;

    while (true) {
      yield conditions;

      if (ctx.matched[COND_START]) {
        inFrame = true;
        isAddressByte = true;
        bits = 0;
        value = 0;
        ctx.put(ctx.samplenum, ctx.samplenum, ANN_START, ["Start", "S"]);
        continue;
      }

      if (ctx.matched[COND_STOP]) {
        inFrame = false;
        bits = 0;
        value = 0;
        ctx.put(ctx.samplenum, ctx.samplenum, ANN_STOP, ["Stop", "P"]);
        continue;
      }

      // COND_CLK: SCL rising -> sample SDA.
      if (!inFrame) continue;
      const sda = ctx.pin(SDA);

      if (bits < 8) {
        if (bits === 0) byteStart = ctx.samplenum;
        value = (value << 1) | sda; // MSB-first
        bits++;
        if (bits === 8) {
          const byteEnd = ctx.samplenum;
          if (isAddressByte) {
            const addr = value >> 1;
            const read = (value & 1) === 1;
            const shown = eightBit ? value : addr;
            ctx.put(byteStart, byteEnd, ANN_ADDR, [
              `${hex(shown)} ${read ? "R" : "W"}`,
              hex(shown),
            ]);
            isAddressByte = false;
          } else {
            const printable = isPrintable(value)
              ? ` '${String.fromCharCode(value)}'`
              : "";
            ctx.put(byteStart, byteEnd, ANN_DATA, [
              `${hex(value)}${printable}`,
              hex(value),
            ]);
            ctx.emit(byteStart, byteEnd, "byte", { value });
          }
        }
      } else {
        // 9th clock: ACK (SDA low) or NACK (SDA high).
        const ack = sda === 0;
        ctx.put(ctx.samplenum, ctx.samplenum, ack ? ANN_ACK : ANN_NACK, [
          ack ? "ACK" : "NACK",
          ack ? "A" : "N",
        ]);
        bits = 0;
        value = 0;
      }
    }
  },
};
