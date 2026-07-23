import { describe, expect, it } from "vitest";
import { CaptureBuffer } from "../model/capture";
import { cond, runDecoder } from "./engine";
import type { Decoder, DecoderContext, PinState, WaitInput } from "./types";

// bit0 rises at index 3; bit1 rises at index 7.
function fixture(): CaptureBuffer {
  const b = new CaptureBuffer(1_000_000, 16);
  b.append(new Uint8Array([0, 0, 0, 1, 1, 1, 1, 3, 3, 3, 3, 3]));
  return b;
}

function makeDecoder(
  gen: (ctx: DecoderContext) => Generator<WaitInput, void, PinState>,
): Decoder {
  return {
    meta: {
      id: "test",
      name: "test",
      longname: "test",
      desc: "",
      channels: [],
      options: [],
      annotations: [["a", "a"]],
      annotationRows: [{ id: "a", name: "a", classes: [0] }],
    },
    decode: gen,
  };
}

function landings(
  gen: (ctx: DecoderContext) => Generator<WaitInput, void, PinState>,
): number[] {
  const { annotations } = runDecoder(makeDecoder(gen), fixture(), [0, 1], {});
  return annotations.map((a) => a.startSample);
}

describe("decode engine wait()", () => {
  it("skip advances by a fixed offset", () => {
    expect(
      landings(function* (ctx) {
        yield { skip: 5 };
        ctx.put(ctx.samplenum, ctx.samplenum, 0, ["x"]);
      }),
    ).toEqual([5]);
  });

  it("rising edge jumps to the transition", () => {
    expect(
      landings(function* (ctx) {
        yield cond(0, "r");
        ctx.put(ctx.samplenum, ctx.samplenum, 0, ["x"]);
        yield cond(1, "r");
        ctx.put(ctx.samplenum, ctx.samplenum, 0, ["y"]);
      }),
    ).toEqual([3, 7]);
  });

  it("OR-matched conditions land on the earliest and set matched flags", () => {
    const { annotations } = runDecoder(
      makeDecoder(function* (ctx) {
        yield [cond(0, "r"), cond(1, "r")];
        ctx.put(ctx.samplenum, ctx.samplenum, 0, [
          ctx.matched.map((m) => (m ? "1" : "0")).join(""),
        ]);
      }),
      fixture(),
      [0, 1],
      {},
    );
    expect(annotations[0].startSample).toBe(3);
    expect(annotations[0].texts[0]).toBe("10"); // ch0 rising matched, ch1 not
  });

  it("level-only condition matches the next sample at that level", () => {
    expect(
      landings(function* (ctx) {
        yield cond(0, "h"); // from 0: first high is at the rising edge, index 3
        ctx.put(ctx.samplenum, ctx.samplenum, 0, ["x"]);
      }),
    ).toEqual([3]);
  });

  it("stable condition matches a non-transition sample (linear fallback)", () => {
    expect(
      landings(function* (ctx) {
        yield cond(0, "s"); // index 1: bit0 unchanged from index 0
        ctx.put(ctx.samplenum, ctx.samplenum, 0, ["x"]);
      }),
    ).toEqual([1]);
  });

  it("stops cleanly when a condition can never be met", () => {
    // No falling edge on bit0 exists -> generator ends, no annotations after.
    expect(
      landings(function* (ctx) {
        yield cond(0, "f");
        ctx.put(ctx.samplenum, ctx.samplenum, 0, ["never"]);
      }),
    ).toEqual([]);
  });

  it("range limits decoding to the window and finds edges within it", () => {
    // Repeatedly land on each rising edge of bit0; edges at 3 (and none later
    // in the fixture). Restrict to [4, 12): the edge at 3 is excluded.
    const gen = function* (ctx: DecoderContext) {
      for (;;) {
        yield cond(0, "r");
        ctx.put(ctx.samplenum, ctx.samplenum, 0, ["r"]);
      }
    };
    const full = runDecoder(makeDecoder(gen), fixture(), [0, 1], {});
    expect(full.annotations.map((a) => a.startSample)).toEqual([3]);

    const windowed = runDecoder(
      makeDecoder(gen),
      fixture(),
      [0, 1],
      {},
      {
        start: 4,
        end: 12,
      },
    );
    expect(windowed.annotations).toEqual([]); // the only rising edge (3) is outside
  });

  it("range decodes edges inside the window (start bit resync)", () => {
    // bit1 rises at 7; a window covering it still catches it.
    const gen = function* (ctx: DecoderContext) {
      yield cond(1, "r");
      ctx.put(ctx.samplenum, ctx.samplenum, 0, ["r"]);
    };
    const windowed = runDecoder(
      makeDecoder(gen),
      fixture(),
      [0, 1],
      {},
      {
        start: 5,
        end: 12,
      },
    );
    expect(windowed.annotations.map((a) => a.startSample)).toEqual([7]);
  });

  it("terminates on a non-advancing wait instead of looping forever", () => {
    // A buggy decoder that yields { skip: 0 } never moves the cursor; the engine
    // must break rather than spin while put()/emit() grow without bound.
    let resumed = 0;
    const { annotations } = runDecoder(
      makeDecoder(function* (ctx) {
        for (;;) {
          yield { skip: 0 };
          resumed++;
          ctx.put(ctx.samplenum, ctx.samplenum, 0, ["x"]);
        }
      }),
      fixture(),
      [0, 1],
      {},
    );
    expect(resumed).toBe(0); // guard broke the loop before the generator resumed
    expect(annotations).toEqual([]);
  });
});
