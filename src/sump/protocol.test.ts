import { describe, expect, it } from "vitest";
import {
  CMD_CAPTURE_SIZE,
  CMD_TRIGGER_CONFIG_0,
  CMD_TRIGGER_MASK_0,
  CMD_TRIGGER_VALUE_0,
  MAX_DIVIDER,
  captureSizeCommand,
  encodeCounts,
  encodeDivider,
  encodeFlags,
  longCommand,
  resetSequence,
  resolveRate,
  triggerCommands,
  triggerStage,
} from "./protocol";

const CLOCK = 100_000_000;

describe("divider", () => {
  it("round-trips the rates a 100 MHz clock divides exactly", () => {
    for (const rate of [
      100_000_000, 50_000_000, 20_000_000, 1_000_000, 10_000,
    ]) {
      const divider = encodeDivider(CLOCK, rate);
      expect(resolveRate(CLOCK, divider)).toBe(rate);
    }
  });

  it("uses divider 0 for the clock itself", () => {
    expect(encodeDivider(CLOCK, CLOCK)).toBe(0);
  });

  // Achievable rates are a divider continuum, so an unrepresentable request has
  // to resolve to the nearest real rate — never be refused, and never be
  // reported back as the rate that was asked for.
  it("resolves a non-integer rate to the nearest achievable one", () => {
    const divider = encodeDivider(CLOCK, 3_000_000); // 100/3 = 33.33 -> 33
    expect(divider).toBe(32);
    expect(resolveRate(CLOCK, divider)).toBe(3_030_303);
    expect(resolveRate(CLOCK, divider)).not.toBe(3_000_000);
  });

  it("clamps to the 24-bit divider field and to zero", () => {
    expect(encodeDivider(CLOCK, 1)).toBe(MAX_DIVIDER);
    expect(encodeDivider(CLOCK, 1e12)).toBe(0);
  });

  it("rejects a nonsensical clock or rate", () => {
    expect(() => encodeDivider(CLOCK, 0)).toThrow();
    expect(() => encodeDivider(0, 1000)).toThrow();
  });
});

describe("read/delay counts", () => {
  // The counts are "groups of four samples, minus one" — the single most
  // commonly mis-encoded field in the protocol.
  it.each([
    [1, 0, 4],
    [4, 0, 4],
    [5, 1, 8],
    [8, 1, 8],
    [1024, 255, 1024],
    [65_536 * 4, 65_535, 65_536 * 4],
  ])(
    "encodes %i samples as readCount %i (%i actual)",
    (samples, rc, actual) => {
      const counts = encodeCounts(samples, samples);
      expect(counts.readCount).toBe(rc);
      expect(counts.samples).toBe(actual);
    },
  );

  it("keeps delaycount equal to readcount for an all-post-trigger capture", () => {
    const counts = encodeCounts(4096, 4096);
    expect(counts.delayCount).toBe(counts.readCount);
  });

  it("never lets the delay count exceed the read count", () => {
    expect(encodeCounts(64, 1024).delayCount).toBe(
      encodeCounts(64, 64).readCount,
    );
  });

  it("packs both counts little-endian into one 0x81 command", () => {
    const cmd = captureSizeCommand(encodeCounts(4096, 4096)); // readCount 1023
    expect(cmd[0]).toBe(CMD_CAPTURE_SIZE);
    // 0x03FF in the low half (read), 0x03FF in the high half (delay).
    expect([...cmd.subarray(1)]).toEqual([0xff, 0x03, 0xff, 0x03]);
  });
});

describe("flags", () => {
  // Bits 2-5 *disable* groups, so enabling only group 0 means disabling 1-3.
  it("is 0x38 for channel group 0 only", () => {
    expect(encodeFlags({ groups: 0x1 })).toBe(0x38);
  });

  it("disables nothing when every group is enabled", () => {
    expect(encodeFlags({ groups: 0xf })).toBe(0x00);
  });

  it("keeps RLE off unless asked, and puts it at bit 8", () => {
    expect(encodeFlags({ groups: 0x1 }) & (1 << 8)).toBe(0);
    expect(encodeFlags({ groups: 0x1, rle: true }) & (1 << 8)).toBe(1 << 8);
  });

  it("sets the external-clock bit at 6", () => {
    expect(encodeFlags({ groups: 0x1, externalClock: true }) & (1 << 6)).toBe(
      1 << 6,
    );
  });
});

describe("long commands", () => {
  it("writes the payload little-endian after the opcode", () => {
    expect([...longCommand(0x80, 0x12345678)]).toEqual([
      0x80, 0x78, 0x56, 0x34, 0x12,
    ]);
  });

  it("sends five reset bytes, so one lands as an opcode either way", () => {
    expect([...resetSequence()]).toEqual([0, 0, 0, 0, 0]);
  });
});

describe("triggerStage", () => {
  it("returns an empty mask for an empty spec, so capture starts at once", () => {
    expect(triggerStage({ conditions: [] })).toEqual({ mask: 0, value: 0 });
  });

  it("builds a level pattern", () => {
    expect(
      triggerStage({
        conditions: [
          { channel: 0, edge: "high" },
          { channel: 3, edge: "low" },
        ],
      }),
    ).toEqual({ mask: 0b1001, value: 0b0001 });
  });

  // A SUMP stage matches a level pattern, not a transition, so anything
  // edge-shaped has to fall through to the software trigger.
  it.each(["rising", "falling", "any"] as const)(
    "returns null for a %s condition",
    (edge) => {
      expect(triggerStage({ conditions: [{ channel: 1, edge }] })).toBeNull();
    },
  );

  it("returns null when any one condition is an edge", () => {
    expect(
      triggerStage({
        conditions: [
          { channel: 0, edge: "high" },
          { channel: 1, edge: "rising" },
        ],
      }),
    ).toBeNull();
  });
});

describe("triggerCommands", () => {
  it("emits mask, value then config, with the start bit on the config", () => {
    const [mask, value, config] = triggerCommands({
      mask: 0x0f,
      value: 0x0a,
    });
    expect(mask[0]).toBe(CMD_TRIGGER_MASK_0);
    expect(value[0]).toBe(CMD_TRIGGER_VALUE_0);
    expect(config[0]).toBe(CMD_TRIGGER_CONFIG_0);
    expect([...mask.subarray(1)]).toEqual([0x0f, 0, 0, 0]);
    expect([...value.subarray(1)]).toEqual([0x0a, 0, 0, 0]);
    // TRIGGER_START is bit 3 of the fourth payload byte.
    expect([...config.subarray(1)]).toEqual([0, 0, 0, 0x08]);
  });
});
