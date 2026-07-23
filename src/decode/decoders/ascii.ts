import type { BytePacket, Decoder, Packet, StackedContext } from "../types";
import { isPrintable } from "../format";

const ANN_TEXT = 0;

/**
 * Stacked decoder: consumes 'byte' packets from a byte-producing decoder
 * (UART / SPI / I²C) and groups runs of printable characters into text
 * annotations — a quick "serial console" view over any byte stream.
 */
export const asciiDecoder: Decoder = {
  meta: {
    id: "ascii",
    name: "ASCII text",
    longname: "Printable text from a byte stream",
    desc: "Groups printable bytes from a stacked byte decoder into strings.",
    inputType: "byte",
    channels: [],
    options: [],
    annotations: [["text", "Text"]],
    annotationRows: [{ id: "text", name: "Text", classes: [ANN_TEXT] }],
  },

  decodeStacked(packets: Packet[], ctx: StackedContext): void {
    let runStart: number | null = null;
    let runEnd = 0;
    let prevEnd = 0;
    let chars: string[] = [];

    const flush = () => {
      if (runStart !== null && chars.length) {
        ctx.put(runStart, runEnd, ANN_TEXT, [chars.join("")]);
      }
      runStart = null;
      chars = [];
    };

    for (const p of packets) {
      const value = Number((p.data as BytePacket).value);
      const printable = isPrintable(value);
      if (!printable) {
        flush();
        continue;
      }

      // Start a fresh annotation when the idle gap before this byte is large
      // relative to the byte's own duration — so each burst of text sits above
      // the UART bytes it came from instead of one annotation spanning gaps.
      const byteDur = Math.max(1, p.endSample - p.startSample);
      const gap = runStart === null ? 0 : p.startSample - prevEnd;
      if (runStart !== null && gap > byteDur * 4) flush();

      if (runStart === null) runStart = p.startSample;
      runEnd = p.endSample;
      prevEnd = p.endSample;
      chars.push(String.fromCharCode(value));
    }
    flush();
  },
};
