import { describe, expect, it, vi } from "vitest";
import {
  render,
  darkPalette,
  type Palette,
  type RenderParams,
  type RenderRow,
} from "./renderer";
import { CaptureBuffer } from "../model/capture";
import { makeFakeCanvas } from "../test/fakeCanvas";

// Build a small buffer with a few transitions so channel traces have edges.
function makeBuffer(): CaptureBuffer {
  const buf = new CaptureBuffer(1_000_000, 16);
  // 8 packed samples: channel 0 toggles, channel 1 stays high, etc.
  buf.append(new Uint8Array([0x00, 0x01, 0x03, 0x02, 0x00, 0x01, 0x03, 0x02]));
  return buf;
}

function baseParams(
  rows: RenderRow[],
  overrides: Partial<RenderParams> = {},
): RenderParams {
  return {
    buf: makeBuffer(),
    view: { viewStart: 0, samplesPerPixel: 1 },
    rows,
    rowHeight: 40,
    width: 1000,
    height: 400,
    rulerHeight: 22,
    originSample: 0,
    triggerSample: null,
    cursors: [],
    dpr: 1,
    ...overrides,
  };
}

describe("renderer.render()", () => {
  it("fills a background, draws ruler text, and strokes gridlines/traces for a channel row", () => {
    const fc = makeFakeCanvas(1000, 400);
    const rows: RenderRow[] = [{ kind: "channel", channel: 0, label: "D0" }];
    render(fc.canvas, baseParams(rows));

    // Background fill.
    expect(fc.count("fillRect")).toBeGreaterThan(0);
    // Ruler draws time labels.
    expect(fc.texts().length).toBeGreaterThan(0);
    // Gridlines + trace path get stroked.
    expect(fc.count("stroke")).toBeGreaterThan(0);
  });

  it("does nothing when the 2D context is unavailable", () => {
    const noCtx = { getContext: () => null } as unknown as HTMLCanvasElement;
    const rows: RenderRow[] = [{ kind: "channel", channel: 0, label: "D0" }];
    expect(() => render(noCtx, baseParams(rows))).not.toThrow();
  });

  it("labels a wide annotation with its text", () => {
    const fc = makeFakeCanvas(1000, 400);
    const rows: RenderRow[] = [
      {
        kind: "annotation",
        label: "UART:Data",
        hue: 120,
        annotations: [
          { startSample: 10, endSample: 900, annClass: 6, texts: ["HELLO"] },
        ],
      },
    ];
    render(fc.canvas, baseParams(rows));
    // measureText in the fake returns text.length*6 (=30 for HELLO), which fits
    // easily in the ~890px-wide box, so pickLabel selects it.
    expect(fc.texts()).toContain("HELLO");
  });

  it("skips the annotation label when the box is too narrow to fit any text", () => {
    const fc = makeFakeCanvas(1000, 400);
    const rows: RenderRow[] = [
      {
        kind: "annotation",
        label: "UART:Data",
        hue: 120,
        // A 1000-sample span at a very coarse zoom collapses to a few pixels.
        annotations: [
          { startSample: 0, endSample: 1000, annClass: 6, texts: ["HELLO"] },
        ],
      },
    ];
    render(
      fc.canvas,
      baseParams(rows, { view: { viewStart: 0, samplesPerPixel: 5000 } }),
    );
    expect(fc.texts()).not.toContain("HELLO");
  });

  it("labels a zero-width point annotation with its text (I²C Start/Stop/ACK)", () => {
    const fc = makeFakeCanvas(1000, 400);
    const rows: RenderRow[] = [
      {
        kind: "annotation",
        label: "I2C:Frame",
        hue: 40,
        // A point event (startSample === endSample) must render a labelled
        // marker, not a bare 2px line.
        annotations: [
          {
            startSample: 500,
            endSample: 500,
            annClass: 0,
            texts: ["Start", "S"],
          },
        ],
      },
    ];
    render(fc.canvas, baseParams(rows));
    expect(fc.texts()).toContain("Start");
  });

  it("draws point markers with the brighter annMark palette color", () => {
    const annMark = vi.fn((hue: number) => `hsl(${hue}, 65%, 45%)`);
    const palette: Palette = { ...darkPalette, annMark };
    const rows: RenderRow[] = [
      {
        kind: "annotation",
        label: "I2C:Ack",
        hue: 280,
        annotations: [
          {
            startSample: 300,
            endSample: 300,
            annClass: 4,
            texts: ["ACK", "A"],
          },
        ],
      },
    ];
    render(makeFakeCanvas(1000, 400).canvas, baseParams(rows, { palette }));
    expect(annMark).toHaveBeenCalledWith(280);
  });

  it("draws a dashed trigger marker only when triggerSample is set", () => {
    const rows: RenderRow[] = [{ kind: "channel", channel: 0, label: "D0" }];

    const withoutTrigger = makeFakeCanvas(1000, 400);
    render(withoutTrigger.canvas, baseParams(rows, { triggerSample: null }));

    const withTrigger = makeFakeCanvas(1000, 400);
    render(withTrigger.canvas, baseParams(rows, { triggerSample: 100 }));

    // The trigger path is dashed (setLineDash) and adds an extra vertical stroke.
    expect(withoutTrigger.count("setLineDash")).toBe(0);
    expect(withTrigger.count("setLineDash")).toBeGreaterThan(0);
    expect(withTrigger.count("stroke")).toBeGreaterThan(
      withoutTrigger.count("stroke"),
    );
  });

  it("draws a vertical stroke for each on-screen cursor", () => {
    const rows: RenderRow[] = [{ kind: "channel", channel: 0, label: "D0" }];
    const noCursors = makeFakeCanvas(1000, 400);
    render(noCursors.canvas, baseParams(rows, { cursors: [] }));

    const twoCursors = makeFakeCanvas(1000, 400);
    render(twoCursors.canvas, baseParams(rows, { cursors: [50, 200] }));

    expect(twoCursors.count("stroke")).toBeGreaterThan(
      noCursors.count("stroke"),
    );
  });

  it("paints the background with the supplied palette (defaulting to dark)", () => {
    const rows: RenderRow[] = [{ kind: "channel", channel: 0, label: "D0" }];

    // The background is the first fillRect; snapshot fillStyle at that moment.
    const bgAt = (fc: ReturnType<typeof makeFakeCanvas>): (() => unknown) => {
      let bg: unknown;
      const orig = fc.ctx.fillRect.bind(fc.ctx);
      fc.ctx.fillRect = ((x: number, y: number, w: number, h: number) => {
        if (bg === undefined) bg = fc.ctx.fillStyle;
        orig(x, y, w, h);
      }) as typeof fc.ctx.fillRect;
      return () => bg;
    };

    const dflt = makeFakeCanvas(1000, 400);
    const dfltBg = bgAt(dflt);
    render(dflt.canvas, baseParams(rows));
    expect(dfltBg()).toBe(darkPalette.bg);

    const custom: Palette = { ...darkPalette, bg: "#ffffff" };
    const themed = makeFakeCanvas(1000, 400);
    const themedBg = bgAt(themed);
    render(themed.canvas, baseParams(rows, { palette: custom }));
    expect(themedBg()).toBe("#ffffff");
  });

  it("fills annotation boxes via the palette's hue-aware annFill", () => {
    const annFill = vi.fn((hue: number) => `hsl(${hue}, 45%, 30%)`);
    const palette: Palette = { ...darkPalette, annFill };
    const rows: RenderRow[] = [
      {
        kind: "annotation",
        label: "UART:Data",
        hue: 200,
        annotations: [
          { startSample: 10, endSample: 900, annClass: 6, texts: ["HELLO"] },
        ],
      },
    ];
    render(makeFakeCanvas(1000, 400).canvas, baseParams(rows, { palette }));
    expect(annFill).toHaveBeenCalledWith(200);
  });
});
