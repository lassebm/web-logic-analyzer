import type { Decoder, DecoderContext, PinState, WaitInput } from "../types";
import { cond, skipToSample } from "../engine";
import { hex } from "../format";

const CANRX = 0;

const ANN_SOF = 0;
const ANN_ID = 1;
const ANN_RTR = 2;
const ANN_IDE = 3;
const ANN_DLC = 4;
const ANN_DATA = 5;
const ANN_CRC = 6;
const ANN_ACK = 7;
const ANN_NACK = 8;
const ANN_WARN = 9;

/**
 * Classical CAN decoder (base + extended frames) on the CAN_RX logic line
 * (dominant = 0, recessive = 1). Samples each bit at its centre, removes stuff
 * bits (5-consecutive rule) through the CRC field, and annotates SOF, ID,
 * RTR/IDE, DLC, data bytes, CRC and ACK. Data bytes are emitted for stacking.
 */
export const canDecoder: Decoder = {
  meta: {
    id: "can",
    name: "CAN",
    longname: "Controller Area Network",
    desc: "Classical CAN (2.0A/2.0B) on the RX line.",
    outputType: "byte",
    channels: [
      { id: "rx", name: "RX", desc: "CAN RX (dominant=low)", required: true },
    ],
    options: [
      {
        id: "bitrate",
        desc: "Bit rate",
        default: 500000,
        // CiA 301's bit-timing table is 1000/800/500/250/125/50/20/10 kbit/s —
        // 100k is not in it. It is in CiA 305's LSS table (index 5), and is
        // common in practice, so it belongs here too; it is also what the app's
        // own demo capture ships. Rates outside both tables (83.333k automotive
        // body buses, say) go in via the "Custom…" entry.
        presets: [
          10000, 20000, 50000, 100000, 125000, 250000, 500000, 800000, 1000000,
        ],
      },
    ],
    annotations: [
      ["sof", "Start of frame"],
      ["id", "Identifier"],
      ["rtr", "RTR"],
      ["ide", "IDE"],
      ["dlc", "DLC"],
      ["data", "Data byte"],
      ["crc", "CRC"],
      ["ack", "ACK"],
      ["nack", "NACK"],
      ["warning", "Warning"],
    ],
    annotationRows: [
      {
        id: "fields",
        name: "Fields",
        classes: [ANN_SOF, ANN_RTR, ANN_IDE, ANN_DLC],
      },
      { id: "id", name: "ID", classes: [ANN_ID] },
      { id: "data", name: "Data", classes: [ANN_DATA] },
      { id: "crcack", name: "CRC/ACK", classes: [ANN_CRC, ANN_ACK, ANN_NACK] },
      { id: "warnings", name: "Warnings", classes: [ANN_WARN] },
    ],
  },

  *decode(ctx: DecoderContext): Generator<WaitInput, void, PinState> {
    const bitrate = Number(ctx.options.bitrate) || 500000;
    const spb = ctx.samplerate / bitrate;

    if (!isFinite(spb) || spb < 3) {
      ctx.put(0, 0, ANN_WARN, [
        "Sample rate too low for CAN bit rate",
        "rate too low",
        "!",
      ]);
      return;
    }

    while (true) {
      // Idle is recessive (high); SOF is the first dominant bit -> falling edge.
      yield cond(CANRX, "f");
      const s0 = ctx.samplenum;

      let rawBitIndex = 0;
      let prev = -1;
      let run = 0;

      const readRaw = function* (): Generator<WaitInput, 0 | 1, PinState> {
        const center = s0 + spb * (rawBitIndex + 0.5);
        yield* skipToSample(ctx, center);
        rawBitIndex++;
        return ctx.pin(CANRX);
      };

      // Read one destuffed bit (consumes a following stuff bit after 5 equal).
      const readBit = function* (): Generator<WaitInput, 0 | 1, PinState> {
        const b = yield* readRaw();
        if (b === prev) run++;
        else {
          prev = b;
          run = 1;
        }
        if (run === 5) {
          const stuff = yield* readRaw();
          prev = stuff;
          run = 1;
        }
        return b;
      };

      // Boundaries come from raw bit indices, not ctx.samplenum: samplenum is
      // the *centre* of the last bit read, so boxes sat half a bit early — a
      // whole bit when readBit had just swallowed a stuff bit.
      const cell = (rawIdx: number) => Math.round(s0 + spb * rawIdx);

      const sof = yield* readBit();
      ctx.put(s0, Math.round(s0 + spb), ANN_SOF, ["SOF", "S"]);
      if (sof !== 0) {
        ctx.put(s0, Math.round(s0 + spb), ANN_WARN, [
          "SOF not dominant",
          "bad SOF",
          "!",
        ]);
      }

      // Base identifier (11 bits, MSB-first).
      const idStartBit = rawBitIndex;
      let id = 0;
      for (let i = 0; i < 11; i++) id = (id << 1) | (yield* readBit());
      let idEndBit = rawBitIndex;

      let rtrBit = rawBitIndex;
      let rtr = yield* readBit(); // RTR (base) or SRR (extended)
      const ide = yield* readBit(); // 0 = standard, 1 = extended
      let extended = false;

      if (ide === 1) {
        extended = true;
        let ext = 0;
        for (let i = 0; i < 18; i++) ext = (ext << 1) | (yield* readBit());
        id = id * (1 << 18) + ext;
        idEndBit = rawBitIndex;
        rtrBit = rawBitIndex;
        rtr = yield* readBit(); // real RTR
        yield* readBit(); // r1
        yield* readBit(); // r0
      } else {
        yield* readBit(); // r0
      }

      ctx.put(cell(idStartBit), cell(idEndBit), ANN_ID, [
        `ID ${hex(id, 0)}${extended ? " ext" : ""}`,
        hex(id, 0),
      ]);
      ctx.put(cell(rtrBit), cell(rtrBit + 1), ANN_RTR, [
        rtr ? "RTR" : "Data",
        rtr ? "R" : "D",
      ]);
      ctx.put(cell(idStartBit), cell(idEndBit), ANN_IDE, [
        extended ? "Ext" : "Std",
      ]);

      // DLC (4 bits).
      const dlcStartBit = rawBitIndex;
      let dlc = 0;
      for (let i = 0; i < 4; i++) dlc = (dlc << 1) | (yield* readBit());
      ctx.put(cell(dlcStartBit), cell(rawBitIndex), ANN_DLC, [`DLC ${dlc}`]);
      const nbytes = Math.min(dlc, 8);

      // Data bytes (data frames only).
      if (rtr === 0) {
        for (let n = 0; n < nbytes; n++) {
          let v = 0;
          const bStartBit = rawBitIndex;
          for (let i = 0; i < 8; i++) v = (v << 1) | (yield* readBit());
          ctx.put(cell(bStartBit), cell(rawBitIndex), ANN_DATA, [hex(v)]);
          ctx.emit(cell(bStartBit), cell(rawBitIndex), "byte", { value: v });
        }
      }

      // CRC (15 bits, still stuffed).
      let crc = 0;
      const crcStartBit = rawBitIndex;
      for (let i = 0; i < 15; i++) crc = (crc << 1) | (yield* readBit());
      ctx.put(cell(crcStartBit), cell(rawBitIndex), ANN_CRC, [
        `CRC ${hex(crc, 0)}`,
        hex(crc, 0),
      ]);

      // Stuffing ends here; the remaining bits are read raw.
      yield* readRaw(); // CRC delimiter (recessive)
      const ackStart = ctx.samplenum;
      const ack = yield* readRaw(); // ACK slot: dominant = acknowledged
      ctx.put(
        ackStart,
        Math.round(ackStart + spb),
        ack === 0 ? ANN_ACK : ANN_NACK,
        [ack === 0 ? "ACK" : "NACK", ack === 0 ? "A" : "N"],
      );
      yield* readRaw(); // ACK delimiter
    }
  },
};
