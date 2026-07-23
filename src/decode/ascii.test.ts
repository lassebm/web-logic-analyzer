import { describe, expect, it } from "vitest";
import { runDecoder, runStacked } from "./engine";
import { uartDecoder } from "./decoders/uart";
import { asciiDecoder } from "./decoders/ascii";
import type { Packet } from "./types";
import { uartBytes } from "../test/waveforms";

describe("ascii stacked decoder", () => {
  it("assembles printable UART bytes into text, splitting on non-printables", () => {
    const sampleRate = 2_000_000;
    const baud = 115200;
    // "Hi" + newline (0x0A, non-printable) + "OK"
    const buf = uartBytes(
      [0x48, 0x69, 0x0a, 0x4f, 0x4b],
      sampleRate / baud,
      sampleRate,
    );

    const { packets } = runDecoder(uartDecoder, buf, [0], { baudrate: baud });
    expect(packets.length).toBe(5);
    expect(packets.every((p: Packet) => p.type === "byte")).toBe(true);

    const anns = runStacked(asciiDecoder, packets, {});
    const texts = anns.map((a) => a.texts[0]);
    expect(texts).toEqual(["Hi", "OK"]);
  });

  it("splits text into separate annotations across a large idle gap", () => {
    const packets: Packet[] = [
      { startSample: 0, endSample: 10, type: "byte", data: { value: 0x41 } }, // 'A'
      { startSample: 10, endSample: 20, type: "byte", data: { value: 0x42 } }, // 'B' (contiguous)
      {
        startSample: 5000,
        endSample: 5010,
        type: "byte",
        data: { value: 0x43 },
      }, // 'C' after gap
    ];
    const anns = runStacked(asciiDecoder, packets, {});
    expect(anns.map((a) => a.texts[0])).toEqual(["AB", "C"]);
  });

  it("produces no text for an all-nonprintable stream", () => {
    const anns = runStacked(
      asciiDecoder,
      [
        { startSample: 0, endSample: 1, type: "byte", data: { value: 0x00 } },
        { startSample: 1, endSample: 2, type: "byte", data: { value: 0x0a } },
      ],
      {},
    );
    expect(anns.length).toBe(0);
  });
});
