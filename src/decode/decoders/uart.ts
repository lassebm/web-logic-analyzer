import type { Decoder, DecoderContext, PinState, WaitInput } from "../types";
import { cond, skipToSample } from "../engine";
import { hex, isPrintable } from "../format";

// Logical channel.
const DATA = 0;

// Annotation classes.
const ANN_START = 0;
const ANN_DATABIT = 1;
const ANN_STOP = 2;
const ANN_PARITY = 3;
const ANN_PARITY_ERR = 4;
const ANN_FRAME_ERR = 5;
const ANN_DATA = 6;
const ANN_WARN = 7;

/**
 * Single-line asynchronous serial (UART) decoder. Decode one line (RX or TX)
 * per instance; add a second instance for the other direction. Faithful to the
 * common 8-N-1 case plus configurable data bits, parity, stop bits, bit order,
 * and inversion.
 */
export const uartDecoder: Decoder = {
  meta: {
    id: "uart",
    name: "UART",
    longname: "Universal Asynchronous Receiver/Transmitter",
    desc: "Asynchronous serial data.",
    outputType: "byte",
    channels: [
      { id: "data", name: "Data", desc: "RX or TX line", required: true },
    ],
    options: [
      {
        id: "baudrate",
        desc: "Baud rate",
        default: 115200,
        presets: [9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600],
      },
      {
        id: "data_bits",
        desc: "Data bits",
        default: 8,
        values: [5, 6, 7, 8, 9],
      },
      {
        id: "parity",
        desc: "Parity",
        default: "none",
        values: ["none", "odd", "even"],
      },
      { id: "stop_bits", desc: "Stop bits", default: 1, values: [1, 2] },
      {
        id: "bit_order",
        desc: "Bit order",
        default: "lsb-first",
        values: ["lsb-first", "msb-first"],
      },
      {
        id: "invert",
        desc: "Invert signal",
        default: "no",
        values: ["no", "yes"],
      },
    ],
    annotations: [
      ["start", "Start bit"],
      ["data-bit", "Data bit"],
      ["stop", "Stop bit"],
      ["parity", "Parity bit"],
      ["parity-error", "Parity error"],
      ["frame-error", "Frame error"],
      ["data", "Data byte"],
      ["warning", "Warning"],
    ],
    annotationRows: [
      {
        id: "bits",
        name: "Bits",
        classes: [ANN_START, ANN_DATABIT, ANN_PARITY, ANN_STOP],
      },
      { id: "data", name: "Data", classes: [ANN_DATA] },
      {
        id: "errors",
        name: "Errors",
        classes: [ANN_PARITY_ERR, ANN_FRAME_ERR, ANN_WARN],
      },
    ],
  },

  *decode(ctx: DecoderContext): Generator<WaitInput, void, PinState> {
    const baudrate = Number(ctx.options.baudrate) || 115200;
    const dataBits = Number(ctx.options.data_bits) || 8;
    const parity = String(ctx.options.parity ?? "none");
    const stopBits = Number(ctx.options.stop_bits) || 1;
    const lsbFirst =
      String(ctx.options.bit_order ?? "lsb-first") === "lsb-first";
    const invert = String(ctx.options.invert ?? "no") === "yes";

    const bit = (v: 0 | 1): 0 | 1 => (invert ? ((1 - v) as 0 | 1) : v);
    const spb = ctx.samplerate / baudrate; // samples per bit

    if (!isFinite(spb) || spb < 1.5) {
      ctx.put(0, 0, ANN_WARN, [
        `Sample rate too low for ${baudrate} baud`,
        "rate too low",
        "!",
      ]);
      return;
    }

    const idleHigh = bit(1); // logical idle level for the data line
    const startEdge = idleHigh === 1 ? "f" : "r"; // start bit departs from idle

    while (true) {
      // Wait for the start-bit edge (departure from idle).
      yield cond(DATA, startEdge);
      const s0 = ctx.samplenum; // first sample of the start bit

      // Sample start-bit centre to confirm framing.
      yield* skipToSample(ctx, s0 + spb * 0.5);
      const startOk = bit(ctx.pin(DATA)) === 0;
      ctx.put(s0, Math.round(s0 + spb), ANN_START, ["Start", "S"]);

      // Data bits.
      let value = 0;
      let ones = 0;
      const bitStart = (i: number) => s0 + spb * (1 + i);
      for (let i = 0; i < dataBits; i++) {
        yield* skipToSample(ctx, bitStart(i) + spb * 0.5);
        const b = bit(ctx.pin(DATA));
        if (b) ones++;
        if (lsbFirst) value |= b << i;
        else value |= b << (dataBits - 1 - i);
        ctx.put(
          Math.round(bitStart(i)),
          Math.round(bitStart(i) + spb),
          ANN_DATABIT,
          [String(b)],
        );
      }

      // Parity bit.
      let parityOk = true;
      if (parity !== "none") {
        yield* skipToSample(ctx, bitStart(dataBits) + spb * 0.5);
        const p = bit(ctx.pin(DATA));
        const expected = parity === "even" ? ones % 2 : 1 - (ones % 2);
        parityOk = p === expected;
        ctx.put(
          Math.round(bitStart(dataBits)),
          Math.round(bitStart(dataBits) + spb),
          ANN_PARITY,
          [`P:${p}`, "P"],
        );
      }

      // Stop bit(s).
      const stopIndex = dataBits + (parity !== "none" ? 1 : 0);
      yield* skipToSample(ctx, bitStart(stopIndex) + spb * 0.5);
      const stopOk = bit(ctx.pin(DATA)) === 1;
      const stopEnd = Math.round(bitStart(stopIndex + stopBits));
      ctx.put(Math.round(bitStart(stopIndex)), stopEnd, ANN_STOP, [
        "Stop",
        "T",
      ]);

      // Emit the assembled byte.
      const dataStart = Math.round(bitStart(0));
      const dataEnd = Math.round(bitStart(dataBits));
      const printable = isPrintable(value) ? String.fromCharCode(value) : "";
      const h = hex(value);
      ctx.put(dataStart, dataEnd, ANN_DATA, [
        printable ? `${h} '${printable}'` : h,
        h,
        value.toString(16).toUpperCase(),
      ]);
      ctx.emit(dataStart, dataEnd, "byte", { value });

      // Errors.
      if (!startOk)
        ctx.put(s0, Math.round(s0 + spb), ANN_FRAME_ERR, [
          "Frame error",
          "FE",
          "!",
        ]);
      if (!parityOk)
        ctx.put(
          Math.round(bitStart(dataBits)),
          Math.round(bitStart(dataBits) + spb),
          ANN_PARITY_ERR,
          ["Parity error", "PE", "!"],
        );
      if (!stopOk)
        ctx.put(Math.round(bitStart(stopIndex)), stopEnd, ANN_FRAME_ERR, [
          "Frame error",
          "FE",
          "!",
        ]);
    }
  },
};
