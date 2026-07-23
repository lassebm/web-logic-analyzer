// A recording 2D canvas context for testing src/view/renderer.ts under Node
// (jsdom's canvas has no real 2D context). It records the draw calls that
// matter for assertions — fillText (labels), fillRect (annotation/trace boxes),
// and the path ops — without rendering anything.

export interface DrawCall {
  op: string;
  args: unknown[];
}

export interface FakeCanvas {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  calls: DrawCall[];
  /** All strings passed to fillText, in order. */
  texts(): string[];
  /** Count of a given op (e.g. 'fillRect'). */
  count(op: string): number;
}

const RECORDED_OPS = [
  "fillRect",
  "strokeRect",
  "clearRect",
  "fillText",
  "strokeText",
  "beginPath",
  "closePath",
  "moveTo",
  "lineTo",
  "stroke",
  "fill",
  "save",
  "restore",
  "translate",
  "setLineDash",
  "setTransform",
  "transform",
  "clip",
  "rect",
  "arc",
];

/**
 * Build a fake canvas of the given size whose getContext('2d') returns a
 * recording context. Pass `fake.canvas` to `render(...)`.
 */
export function makeFakeCanvas(width = 1000, height = 400): FakeCanvas {
  const calls: DrawCall[] = [];

  const ctx = {
    canvas: null as unknown as HTMLCanvasElement,
    // mutable style state renderer sets freely
    fillStyle: "#000",
    strokeStyle: "#000",
    lineWidth: 1,
    font: "10px sans-serif",
    textAlign: "left" as CanvasTextAlign,
    textBaseline: "alphabetic" as CanvasTextBaseline,
    globalAlpha: 1,
    measureText(text: string) {
      return { width: text.length * 6 } as TextMetrics;
    },
  } as unknown as CanvasRenderingContext2D;

  for (const op of RECORDED_OPS) {
    (ctx as unknown as Record<string, unknown>)[op] = (...args: unknown[]) => {
      calls.push({ op, args });
    };
  }

  const canvas = {
    width,
    height,
    style: {} as Record<string, string>,
    getContext: (kind: string) => (kind === "2d" ? ctx : null),
    getBoundingClientRect: () => ({
      left: 0,
      top: 0,
      width,
      height,
      right: width,
      bottom: height,
      x: 0,
      y: 0,
    }),
  } as unknown as HTMLCanvasElement;
  (ctx as unknown as { canvas: HTMLCanvasElement }).canvas = canvas;

  return {
    canvas,
    ctx,
    calls,
    texts: () =>
      calls
        .filter((c) => c.op === "fillText" || c.op === "strokeText")
        .map((c) => String(c.args[0])),
    count: (op: string) => calls.filter((c) => c.op === op).length,
  };
}
