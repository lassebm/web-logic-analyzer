import { beforeEach, describe, expect, it } from "vitest";
import { get } from "svelte/store";
import {
  captureBuffer,
  decoders,
  addDecoder,
  removeDecoder,
  moveDecoder,
  updateDecoder,
  setDecoderEnabled,
  setAllDecodersEnabled,
  runAllDecoders,
  decodersEnabled,
} from "./session";
import { packLevels, uartFrame, uartFrameLevels } from "../test/waveforms";

const ANN_DATA = 6; // UART data-byte annotation class

/** A single-byte UART frame (8-N-1, LSB-first) on channel 0. */
const buildUart = (byte: number, sampleRate = 2_000_000, baud = 115200) =>
  uartFrame(byte, sampleRate / baud, sampleRate);

/** Two independent UART frames on channel 0 and channel 1 (same timing).
 * Baud matches the uart decoder's default so added instances decode as-is. */
function buildTwoChannelUart(
  byte0: number,
  byte1: number,
  sampleRate = 2_000_000,
  baud = 115200,
) {
  const spb = sampleRate / baud;
  const ch0 = uartFrameLevels(byte0, spb);
  const ch1 = uartFrameLevels(byte1, spb); // identical length for a given spb
  return packLevels(
    sampleRate,
    ch0.map((v, i) => (v & 1) | ((ch1[i] & 1) << 1)),
  );
}

beforeEach(() => {
  captureBuffer.set(null);
  decoders.set([]);
  decodersEnabled.set(true);
});

describe("session decoder orchestration", () => {
  it("runs a logic decoder over the capture and fills annotations", () => {
    captureBuffer.set(buildUart(0x41));
    addDecoder("uart");
    const list = get(decoders);
    expect(list.length).toBe(1);
    expect(list[0].annotations.some((a) => a.annClass === ANN_DATA)).toBe(true);
  });

  it("auto-stacks the ASCII decoder on the UART byte stream", () => {
    captureBuffer.set(buildUart(0x41)); // 'A'
    addDecoder("uart");
    addDecoder("ascii");
    const ascii = get(decoders).find((d) => d.decoderId === "ascii");
    expect(ascii?.stackOnUid).toBeTruthy(); // linked to the uart instance
    const text = (ascii?.annotations ?? []).map((a) => a.texts[0]).join("");
    expect(text).toContain("A");
  });

  it("runs multiple independent logic decoders, each on its own channel", () => {
    captureBuffer.set(buildTwoChannelUart(0x41, 0x42)); // 'A' on ch0, 'B' on ch1
    addDecoder("uart"); // defaults to channel 0
    addDecoder("uart");
    const [d0, d1] = get(decoders);
    updateDecoder(d1.uid, { channelMap: [1] }); // second instance reads channel 1

    const list = get(decoders);
    expect(list.length).toBe(2);
    const dataTexts = (uid: string) =>
      get(decoders)
        .find((d) => d.uid === uid)!
        .annotations.filter((a) => a.annClass === ANN_DATA)
        .flatMap((a) => a.texts);
    // Each instance decodes its own channel's byte, independently.
    expect(dataTexts(d0.uid)).toContain("0x41");
    expect(dataTexts(d0.uid)).not.toContain("0x42");
    expect(dataTexts(d1.uid)).toContain("0x42");
    expect(dataTexts(d1.uid)).not.toContain("0x41");
  });

  it("binds a stacked decoder to the chosen source among several candidates", () => {
    captureBuffer.set(buildTwoChannelUart(0x41, 0x42)); // 'A' on ch0, 'B' on ch1
    addDecoder("uart");
    addDecoder("uart");
    const [uartA, uartB] = get(decoders);
    updateDecoder(uartB.uid, { channelMap: [1] });

    addDecoder("ascii");
    const asciiUid = get(decoders).find((d) => d.decoderId === "ascii")!.uid;
    const asciiText = () =>
      get(decoders)
        .find((d) => d.uid === asciiUid)!
        .annotations.map((a) => a.texts[0])
        .join("");

    // Auto-stacks onto the first compatible source ('A').
    expect(get(decoders).find((d) => d.uid === asciiUid)!.stackOnUid).toBe(
      uartA.uid,
    );
    expect(asciiText()).toContain("A");

    // Rebinding to the second source re-decodes that source's bytes ('B').
    updateDecoder(asciiUid, { stackOnUid: uartB.uid });
    expect(asciiText()).toContain("B");
    expect(asciiText()).not.toContain("A");
  });

  it("applies channelMap and option overrides when adding (e.g. from detection)", () => {
    captureBuffer.set(buildUart(0x41));
    addDecoder("uart", {
      channelMap: [3],
      options: { baudrate: 9600, parity: "even" },
    });
    const inst = get(decoders)[0];
    expect(inst.channelMap).toEqual([3]);
    expect(inst.options.baudrate).toBe(9600);
    expect(inst.options.parity).toBe("even");
    expect(inst.options.data_bits).toBe(8); // unspecified options keep their defaults
  });

  it("re-decodes when options change and supports removal", () => {
    captureBuffer.set(buildUart(0x41));
    addDecoder("uart");
    const uid = get(decoders)[0].uid;

    // Wrong baud -> the byte should no longer decode as 0x41.
    updateDecoder(uid, { options: { baudrate: 9600, data_bits: 8 } });
    const wrong = get(decoders)[0].annotations.filter(
      (a) => a.annClass === ANN_DATA,
    );
    expect(wrong.every((a) => !a.texts.includes("0x41"))).toBe(true);

    removeDecoder(uid);
    expect(get(decoders).length).toBe(0);
  });

  it("defaults to enabled, globally and per decoder", () => {
    expect(get(decodersEnabled)).toBe(true);
    captureBuffer.set(buildUart(0x41));
    addDecoder("uart");
    expect(get(decoders)[0].enabled).toBe(true);
  });

  it("disabling a decoder clears its annotations; re-enabling decodes again", () => {
    captureBuffer.set(buildUart(0x41));
    addDecoder("uart");
    const uid = get(decoders)[0].uid;
    expect(get(decoders)[0].annotations.length).toBeGreaterThan(0);

    setDecoderEnabled(uid, false);
    expect(get(decoders)[0].enabled).toBe(false);
    expect(get(decoders)[0].annotations.length).toBe(0); // lane cleared

    setDecoderEnabled(uid, true);
    expect(get(decoders)[0].annotations.length).toBeGreaterThan(0); // decoded again
  });

  it("the master switch disables/enables all decoders at once", () => {
    captureBuffer.set(buildTwoChannelUart(0x41, 0x42));
    addDecoder("uart");
    addDecoder("uart");
    updateDecoder(get(decoders)[1].uid, { channelMap: [1] });
    expect(get(decoders).every((d) => d.annotations.length > 0)).toBe(true);

    setAllDecodersEnabled(false);
    expect(get(decoders).every((d) => d.annotations.length === 0)).toBe(true);

    setAllDecodersEnabled(true);
    expect(get(decoders).every((d) => d.annotations.length > 0)).toBe(true);
  });

  it("reorders decoders, preserving each instance's annotations", () => {
    captureBuffer.set(buildTwoChannelUart(0x41, 0x42));
    addDecoder("uart"); // ch0 -> index 0
    addDecoder("uart");
    const [d0, d1] = get(decoders);
    updateDecoder(d1.uid, { channelMap: [1] });
    const annsBefore = get(decoders).map((d) => d.annotations.length);
    expect(annsBefore.every((n) => n > 0)).toBe(true);

    moveDecoder(d1.uid, 0); // drag the second decoder to the top
    const order = get(decoders).map((d) => d.uid);
    expect(order).toEqual([d1.uid, d0.uid]);
    // A pure reorder keeps annotations intact (no re-decode needed).
    expect(get(decoders).map((d) => d.annotations.length)).toEqual(
      annsBefore.slice().reverse(),
    );
  });

  it("clamps an out-of-range move and no-ops on an unknown uid", () => {
    captureBuffer.set(buildTwoChannelUart(0x41, 0x42));
    addDecoder("uart");
    addDecoder("uart");
    const [d0, d1] = get(decoders);

    moveDecoder(d0.uid, 99); // clamped to the last position
    expect(get(decoders).map((d) => d.uid)).toEqual([d1.uid, d0.uid]);

    moveDecoder("nope", 0); // unknown uid leaves the order untouched
    expect(get(decoders).map((d) => d.uid)).toEqual([d1.uid, d0.uid]);
  });

  it("a disabled decoder is skipped in a live in-view pass too", () => {
    captureBuffer.set(buildTwoChannelUart(0x41, 0x42)); // 'A' on ch0, 'B' on ch1
    addDecoder("uart"); // ch0
    addDecoder("uart");
    const [d0, d1] = get(decoders);
    updateDecoder(d1.uid, { channelMap: [1] });
    setDecoderEnabled(d1.uid, false);

    const n = get(captureBuffer)!.sampleCount;
    runAllDecoders({ start: 0, end: n }); // windowed (live) pass

    const byUid = (uid: string) => get(decoders).find((d) => d.uid === uid)!;
    expect(byUid(d0.uid).annotations.length).toBeGreaterThan(0);
    expect(byUid(d1.uid).annotations.length).toBe(0);
  });
});
