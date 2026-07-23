import { beforeEach, describe, expect, it } from "vitest";
import { get } from "svelte/store";
import {
  captureBuffer,
  decoders,
  monitorActive,
  sampleSource,
  loadDemo,
} from "./session";
import { DEMO_DECODERS } from "../demo/capture";

beforeEach(() => {
  captureBuffer.set(null);
  decoders.set([]);
  monitorActive.set(false);
});

describe("loadDemo", () => {
  it("loads the demo capture and adds one decoder per protocol, pre-wired", () => {
    expect(loadDemo()).toBe(true);

    expect(get(captureBuffer)?.sampleCount ?? 0).toBeGreaterThan(0);

    const added = get(decoders);
    expect(added.map((d) => d.decoderId)).toEqual(
      DEMO_DECODERS.map((d) => d.decoderId),
    );
    // Each is wired to the demo's channel map.
    added.forEach((inst, i) =>
      expect(inst.channelMap).toEqual(DEMO_DECODERS[i].channelMap),
    );
    // Loaded (not captured) — the readout must not show a "% of limit".
    expect(get(sampleSource)).toBe("demo");
  });

  it("auto-wires the ASCII decoder onto the demo UART and decodes the text", () => {
    loadDemo();
    const added = get(decoders);
    const uart = added.find((d) => d.decoderId === "uart")!;
    const ascii = added.find((d) => d.decoderId === "ascii")!;
    // Stacked source resolves to the UART instance that precedes it.
    expect(ascii.stackOnUid).toBe(uart.uid);
    const text = ascii.annotations.map((a) => a.texts[0]).join("");
    expect(text).toContain("Hello");
  });

  it("replaces any existing decoders rather than appending", () => {
    loadDemo();
    loadDemo();
    expect(get(decoders)).toHaveLength(DEMO_DECODERS.length);
  });

  it("is a no-op while the Serial Monitor owns the device", () => {
    monitorActive.set(true);
    expect(loadDemo()).toBe(false);
    expect(get(captureBuffer)).toBeNull();
    expect(get(decoders)).toHaveLength(0);
  });
});
