import { describe, expect, it } from "vitest";
import { buildDemoCapture, DEMO_DECODERS } from "./capture";
import { runDecoder } from "../decode/engine";
import { getDecoder } from "../decode/registry";
import { scanChannels, detectI2c } from "../decode/detect";

const buf = buildDemoCapture();

/** Run a demo decoder by its DEMO_DECODERS entry index. */
function run(idx: number) {
  const d = DEMO_DECODERS[idx];
  const dec = getDecoder(d.decoderId)!;
  const options: Record<string, string | number> = {};
  for (const o of dec.meta.options) options[o.id] = o.default;
  Object.assign(options, d.options);
  return runDecoder(dec, buf, d.channelMap, options);
}

function values(packets: { data: unknown }[]): number[] {
  return packets.map((p) => (p.data as { value: number }).value);
}

describe("demo capture", () => {
  it("carries a UART telegram on D0", () => {
    // "Hello\n"
    expect(values(run(0).packets)).toEqual([
      0x48, 0x65, 0x6c, 0x6c, 0x6f, 0x0a,
    ]);
  });

  it("carries SPI MOSI/MISO words on D1..D3 (3-wire)", () => {
    const spi = run(2);
    expect(
      spi.annotations.filter((a) => a.annClass === 0).map((a) => a.texts[1]),
    ).toEqual(["0x9F", "0xA5", "0x3C"]);
    expect(
      spi.annotations.filter((a) => a.annClass === 1).map((a) => a.texts[1]),
    ).toEqual(["0xEF", "0x5A", "0xC3"]);
  });

  it("carries two I²C transactions on D4/D5", () => {
    const i2c = run(3);
    expect(i2c.annotations.some((a) => a.annClass === 0)).toBe(true); // START
    expect(i2c.annotations.some((a) => a.annClass === 1)).toBe(true); // STOP
    expect(i2c.annotations.filter((a) => a.annClass === 2).length).toBe(2); // 2 addrs
  });

  it("carries a 1-Wire reset/presence + bytes on D6", () => {
    const ow = run(4);
    expect(ow.annotations.some((a) => a.annClass === 0)).toBe(true); // reset
    expect(ow.annotations.some((a) => a.annClass === 1)).toBe(true); // presence
    expect(values(ow.packets)).toEqual([0x33, 0xcc]);
  });

  it("carries two CAN frames on D7", () => {
    const can = run(5);
    expect(
      can.annotations.filter((a) => a.annClass === 1).map((a) => a.texts[1]),
    ).toEqual(["0x123", "0x7A5"]);
  });

  it("auto-detects the UART line and the I²C bus with the right wiring", () => {
    const hits = scanChannels(buf, [0, 1, 2, 3, 4, 5, 6, 7]);

    const uart = hits.find((h) => h.kind === "uart" && h.channels[0] === 0);
    expect(uart).toBeTruthy();
    expect(uart!.kind === "uart" && uart!.baudrate).toBe(115200);

    const i2c = hits.filter((h) => h.kind === "i2c");
    expect(i2c).toHaveLength(1);
    expect(i2c[0].channels).toEqual([4, 5]); // SCL, SDA resolved correctly
  });

  it("does not mistake unrelated channel pairs for an I²C bus", () => {
    // The SPI clock, 1-Wire, and CAN lines must not pair up as phantom buses —
    // the robustness guarantee that matters for a multi-protocol capture.
    for (const [a, b] of [
      [4, 1],
      [1, 4],
      [6, 0],
      [7, 2],
      [1, 6],
      [3, 7],
    ]) {
      expect(detectI2c(buf, a, b), `${a},${b}`).toBeNull();
    }
  });
});
