import { describe, expect, it } from "vitest";
import { CaptureBuffer } from "../model/capture";
import { runDecoder } from "./engine";
import { canDecoder } from "./decoders/can";
import { packLevels } from "../test/waveforms";

const ANN_ID = 1;
const ANN_DLC = 4;
const ANN_DATA = 5;
const ANN_ACK = 7;

/**
 * Encode a standard CAN data frame to a logic waveform (dominant=0/recessive=1),
 * applying the 5-consecutive bit-stuffing rule over SOF..CRC. This is an
 * independent implementation from the decoder's destuffing, so a passing test
 * exercises both directions.
 */
function buildCanStdFrame(
  id: number,
  data: number[],
  spb: number,
): CaptureBuffer {
  const logical: number[] = [];
  logical.push(0); // SOF
  for (let i = 10; i >= 0; i--) logical.push((id >> i) & 1); // 11-bit ID
  logical.push(0); // RTR (data frame)
  logical.push(0); // IDE (standard)
  logical.push(0); // r0
  const dlc = data.length;
  for (let i = 3; i >= 0; i--) logical.push((dlc >> i) & 1); // DLC
  for (const b of data) for (let i = 7; i >= 0; i--) logical.push((b >> i) & 1);
  const crc = 0x2aaa; // arbitrary alternating pattern (value not verified)
  for (let i = 14; i >= 0; i--) logical.push((crc >> i) & 1);

  // Apply bit stuffing.
  const stuffed: number[] = [];
  let prev = -1;
  let run = 0;
  for (const b of logical) {
    stuffed.push(b);
    if (b === prev) run++;
    else {
      prev = b;
      run = 1;
    }
    if (run === 5) {
      const s = prev ^ 1;
      stuffed.push(s);
      prev = s;
      run = 1;
    }
  }

  // Unstuffed tail: CRC delimiter, ACK (dominant), ACK delimiter, EOF.
  stuffed.push(1, 0, 1, 1, 1, 1, 1, 1, 1, 1);

  const levels: number[] = [];
  for (let i = 0; i < 30; i++) levels.push(1); // idle recessive
  for (const b of stuffed) for (let k = 0; k < spb; k++) levels.push(b);
  for (let i = 0; i < 30; i++) levels.push(1);

  return packLevels(1_000_000, levels);
}

/** Encode an extended (29-bit ID) CAN data frame with bit stuffing. */
function buildCanExtFrame(
  id29: number,
  data: number[],
  spb: number,
): CaptureBuffer {
  const base = Math.floor(id29 / (1 << 18)); // top 11 bits
  const ext = id29 % (1 << 18); // low 18 bits
  const logical: number[] = [];
  logical.push(0); // SOF
  for (let i = 10; i >= 0; i--) logical.push((base >> i) & 1);
  logical.push(1); // SRR (recessive)
  logical.push(1); // IDE = extended
  for (let i = 17; i >= 0; i--) logical.push((ext >> i) & 1);
  logical.push(0); // RTR (data)
  logical.push(0); // r1
  logical.push(0); // r0
  const dlc = data.length;
  for (let i = 3; i >= 0; i--) logical.push((dlc >> i) & 1);
  for (const b of data) for (let i = 7; i >= 0; i--) logical.push((b >> i) & 1);
  for (let i = 14; i >= 0; i--) logical.push((0x2aaa >> i) & 1); // CRC

  const stuffed: number[] = [];
  let prev = -1;
  let run = 0;
  for (const b of logical) {
    stuffed.push(b);
    if (b === prev) run++;
    else {
      prev = b;
      run = 1;
    }
    if (run === 5) {
      const s = prev ^ 1;
      stuffed.push(s);
      prev = s;
      run = 1;
    }
  }
  stuffed.push(1, 0, 1, 1, 1, 1, 1, 1, 1, 1); // CRC delim, ACK, ACK delim, EOF

  const levels: number[] = [];
  for (let i = 0; i < 30; i++) levels.push(1);
  for (const b of stuffed) for (let k = 0; k < spb; k++) levels.push(b);
  for (let i = 0; i < 30; i++) levels.push(1);

  return packLevels(1_000_000, levels);
}

describe("can decoder", () => {
  it("decodes a standard data frame with stuffing", () => {
    const id = 0x123;
    const data = [0xde, 0xad];
    const buf = buildCanStdFrame(id, data, 10); // 100 kbit at 1 MHz

    const { annotations, packets } = runDecoder(canDecoder, buf, [0], {
      bitrate: 100000,
    });

    const ids = annotations.filter((a) => a.annClass === ANN_ID);
    expect(ids.length).toBe(1);
    expect(ids[0].texts[1]).toBe("0x123");

    const dlc = annotations.filter((a) => a.annClass === ANN_DLC);
    expect(dlc[0].texts[0]).toBe("DLC 2");

    const bytes = annotations
      .filter((a) => a.annClass === ANN_DATA)
      .map((a) => a.texts[0]);
    expect(bytes).toEqual(["0xDE", "0xAD"]);

    // Data bytes are stackable.
    expect(packets.map((p) => (p.data as { value: number }).value)).toEqual([
      0xde, 0xad,
    ]);

    // ACK slot was dominant.
    expect(annotations.some((a) => a.annClass === ANN_ACK)).toBe(true);
  });

  it("decodes an extended (29-bit) data frame", () => {
    const id = (0x123 << 18) | 0x1abcd; // 0x48DABCD
    const buf = buildCanExtFrame(id, [0x55], 10);
    const { annotations } = runDecoder(canDecoder, buf, [0], {
      bitrate: 100000,
    });

    const ids = annotations.filter((a) => a.annClass === ANN_ID);
    expect(ids.length).toBe(1);
    expect(ids[0].texts[1]).toBe("0x48DABCD");

    const bytes = annotations
      .filter((a) => a.annClass === ANN_DATA)
      .map((a) => a.texts[0]);
    expect(bytes).toEqual(["0x55"]);
  });
});
describe("can annotation placement", () => {
  const ANN_RTR = 2;
  // The frame starts at sample 30 (the idle preamble) — see buildCanStdFrame.
  const FRAME_START = 30;

  // Field boundaries used to be taken from ctx.samplenum, the *centre* of the
  // last bit read, so every box sat half a bit early; when readBit had just
  // swallowed a stuff bit at a field boundary it was a whole bit off, drawing the
  // RTR box over the stuff bit.
  it("aligns field annotations to whole bit cells", () => {
    const spb = 10;
    const buf = buildCanStdFrame(0x01f, [0x11], spb);
    const { annotations } = runDecoder(canDecoder, buf, [0], {
      bitrate: buf.sampleRate / spb,
    });

    const one = (cls: number) => annotations.find((a) => a.annClass === cls)!;
    const id = one(ANN_ID);
    const rtr = one(ANN_RTR);

    // Every boundary lands on a bit-cell edge relative to the frame start.
    for (const a of [id, rtr, one(ANN_DLC), one(ANN_DATA)]) {
      expect((a.startSample - FRAME_START) % spb).toBe(0);
      expect((a.endSample - FRAME_START) % spb).toBe(0);
    }
    // The ID field starts one bit cell after SOF and RTR follows it directly.
    expect(id.startSample).toBe(FRAME_START + spb);
    expect(rtr.startSample).toBe(id.endSample);
    expect(rtr.endSample - rtr.startSample).toBe(spb);
  });
});
