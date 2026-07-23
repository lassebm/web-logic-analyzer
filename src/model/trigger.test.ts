import { describe, expect, it } from "vitest";
import { CaptureBuffer } from "./capture";
import { findTrigger } from "./trigger";

function buf(bytes: number[]): CaptureBuffer {
  const b = new CaptureBuffer(1_000_000, bytes.length);
  b.append(new Uint8Array(bytes));
  return b;
}

describe("findTrigger", () => {
  it("returns 0 for an empty spec (origin at start)", () => {
    expect(findTrigger(buf([0, 1, 0]), { conditions: [] })).toBe(0);
  });

  it("finds a rising edge", () => {
    // channel 0: 0,0,1,1 -> rising at index 2
    expect(
      findTrigger(buf([0, 0, 1, 1]), {
        conditions: [{ channel: 0, edge: "rising" }],
      }),
    ).toBe(2);
  });

  it("finds a falling edge", () => {
    expect(
      findTrigger(buf([1, 1, 0]), {
        conditions: [{ channel: 0, edge: "falling" }],
      }),
    ).toBe(2);
  });

  it("matches a level (first sample already high)", () => {
    expect(
      findTrigger(buf([1, 0, 0]), {
        conditions: [{ channel: 0, edge: "high" }],
      }),
    ).toBe(0);
  });

  it("requires all conditions at the same sample (AND)", () => {
    // ch0 high AND ch1 low: byte bit0=ch0, bit1=ch1
    // idx0: 0b01 (ch0=1,ch1=0) -> matches immediately
    expect(
      findTrigger(buf([0b01, 0b11]), {
        conditions: [
          { channel: 0, edge: "high" },
          { channel: 1, edge: "low" },
        ],
      }),
    ).toBe(0);
    // idx where ch0=1 and ch1=0: 0b11(no),0b01(yes at idx1)
    expect(
      findTrigger(buf([0b11, 0b01]), {
        conditions: [
          { channel: 0, edge: "high" },
          { channel: 1, edge: "low" },
        ],
      }),
    ).toBe(1);
  });

  it("matches any transition (rising or falling) but not a steady level", () => {
    // 0,0,1,1,0 -> rising at idx2 is the first transition
    expect(
      findTrigger(buf([0, 0, 1, 1, 0]), {
        conditions: [{ channel: 0, edge: "any" }],
      }),
    ).toBe(2);
    // 1,1,0 -> falling at idx2 is the first transition
    expect(
      findTrigger(buf([1, 1, 0]), {
        conditions: [{ channel: 0, edge: "any" }],
      }),
    ).toBe(2);
    // steady level never transitions -> no match
    expect(
      findTrigger(buf([1, 1, 1]), {
        conditions: [{ channel: 0, edge: "any" }],
      }),
    ).toBe(-1);
  });

  it("returns -1 when never satisfied", () => {
    expect(
      findTrigger(buf([0, 0, 0]), {
        conditions: [{ channel: 0, edge: "rising" }],
      }),
    ).toBe(-1);
  });
});
