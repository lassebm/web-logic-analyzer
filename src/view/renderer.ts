import type { CaptureBuffer } from "../model/capture";
import type { Annotation } from "../decode/types";

export interface WaveView {
  /** Leftmost sample index (float). */
  viewStart: number;
  /** Samples per horizontal pixel (float, > 0). */
  samplesPerPixel: number;
}

export type RenderRow =
  | { kind: "channel"; channel: number; label: string }
  | {
      kind: "annotation";
      label: string;
      annotations: Annotation[];
      hue: number;
    };

export interface RenderParams {
  buf: CaptureBuffer;
  view: WaveView;
  rows: RenderRow[];
  rowHeight: number;
  width: number;
  height: number;
  /** Height of the time-axis band drawn at the top. */
  rulerHeight: number;
  /** Sample treated as t=0 (the trigger, else 0 = capture start). */
  originSample: number;
  triggerSample: number | null;
  cursors: number[];
  dpr: number;
  /** Canvas color palette. Defaults to {@link darkPalette}. */
  palette?: Palette;
}

/**
 * Canvas color palette. Kept separate from the CSS `--*` tokens so the waveform
 * can be themed from the same source of truth if a light theme is ever added;
 * pass one via {@link RenderParams.palette}.
 */
export interface Palette {
  bg: string;
  ruler: string;
  grid: string;
  gridFaint: string;
  rulerText: string;
  trace: string;
  trigger: string;
  cursor: string;
  annStroke: string;
  annText: string;
  /** Fill for an annotation box, given its lane hue. */
  annFill: (hue: number) => string;
  /**
   * Fill for a point marker (a zero-width event like I²C Start/Stop/ACK), given
   * its lane hue. Brighter than {@link annFill} so momentary events stand out
   * from the data boxes around them.
   */
  annMark: (hue: number) => string;
}

export const darkPalette: Palette = {
  bg: "#0f1115",
  ruler: "#141821",
  grid: "#20242e",
  gridFaint: "#191d26",
  rulerText: "#8b93a3",
  trace: "#4fd48a",
  trigger: "#ffcc5c",
  cursor: "#4f9dff",
  annStroke: "#2a2f3a",
  annText: "#e8ebf1",
  annFill: (hue) => `hsl(${hue}, 45%, 30%)`,
  annMark: (hue) => `hsl(${hue}, 65%, 45%)`,
};

/** Round a raw seconds value up to a "nice" 1/2/5×10ⁿ step. */
export function niceTimeStep(raw: number): number {
  if (!isFinite(raw) || raw <= 0) return 1;
  const pow = Math.pow(10, Math.floor(Math.log10(raw)));
  const n = raw / pow;
  const m = n < 1.5 ? 1 : n < 3.5 ? 2 : n < 7.5 ? 5 : 10;
  return m * pow;
}

/** Format a time offset (seconds) with an appropriate unit, trimming zeros. */
export function formatTime(sec: number): string {
  if (sec === 0) return "0";
  const a = Math.abs(sec);
  let unit = "s";
  let div = 1;
  if (a < 1e-6) {
    unit = "ns";
    div = 1e-9;
  } else if (a < 1e-3) {
    unit = "µs";
    div = 1e-6;
  } else if (a < 1) {
    unit = "ms";
    div = 1e-3;
  }
  const v = sec / div;
  const av = Math.abs(v);
  const s = av >= 100 ? v.toFixed(0) : av >= 10 ? v.toFixed(1) : v.toFixed(2);
  return `${parseFloat(s)} ${unit}`;
}

/** Sample index -> pixel x. */
export function sampleToX(sample: number, view: WaveView): number {
  return (sample - view.viewStart) / view.samplesPerPixel;
}

/** Pixel x -> sample index. */
export function xToSample(x: number, view: WaveView): number {
  return view.viewStart + x * view.samplesPerPixel;
}

export function render(canvas: HTMLCanvasElement, p: RenderParams): void {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  const { dpr, width, height } = p;
  canvas.width = Math.max(1, Math.floor(width * dpr));
  canvas.height = Math.max(1, Math.floor(height * dpr));
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  const pal = p.palette ?? darkPalette;

  ctx.fillStyle = pal.bg;
  ctx.fillRect(0, 0, width, height);

  // Time ruler + gridlines span the full height (drawn first, behind traces).
  drawRuler(ctx, p, pal);

  // Row separators (offset below the ruler).
  ctx.strokeStyle = pal.grid;
  ctx.lineWidth = 1;
  for (let i = 1; i < p.rows.length; i++) {
    const y = Math.floor(p.rulerHeight + i * p.rowHeight) + 0.5;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(width, y);
    ctx.stroke();
  }

  p.rows.forEach((row, i) => {
    const top = p.rulerHeight + i * p.rowHeight;
    if (row.kind === "channel") drawChannel(ctx, p, pal, row.channel, top);
    else drawAnnotationLane(ctx, p, pal, row.annotations, row.hue, top);
  });

  drawTrigger(ctx, p, pal);
  drawCursors(ctx, p, pal);
}

function drawRuler(
  ctx: CanvasRenderingContext2D,
  p: RenderParams,
  pal: Palette,
): void {
  const { view, width, rulerHeight, height, buf } = p;
  const sr = buf.sampleRate;

  ctx.fillStyle = pal.ruler;
  ctx.fillRect(0, 0, width, rulerHeight);
  ctx.strokeStyle = pal.grid;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, rulerHeight + 0.5);
  ctx.lineTo(width, rulerHeight + 0.5);
  ctx.stroke();

  const secPerPx = view.samplesPerPixel / sr;
  if (!isFinite(secPerPx) || secPerPx <= 0 || sr <= 0) return;

  const step = niceTimeStep(secPerPx * 90); // aim for a tick roughly every 90px
  const stepSamples = step * sr;
  if (!isFinite(stepSamples) || stepSamples <= 0) return;

  const origin = p.originSample;
  const leftSample = xToSample(0, view);
  let k = Math.ceil((leftSample - origin) / stepSamples);

  ctx.font = "10px ui-monospace, monospace";
  ctx.textBaseline = "top";
  for (let guard = 0; guard < 5000; guard++, k++) {
    const s = origin + k * stepSamples;
    const x = sampleToX(s, view);
    if (x > width + 1) break;
    if (x < -1) continue;

    ctx.strokeStyle = pal.gridFaint;
    ctx.beginPath();
    ctx.moveTo(x + 0.5, rulerHeight);
    ctx.lineTo(x + 0.5, height);
    ctx.stroke();

    ctx.strokeStyle = pal.grid;
    ctx.beginPath();
    ctx.moveTo(x + 0.5, rulerHeight - 5);
    ctx.lineTo(x + 0.5, rulerHeight);
    ctx.stroke();

    ctx.fillStyle = pal.rulerText;
    ctx.fillText(formatTime(k * step), x + 3, 3);
  }
}

function drawChannel(
  ctx: CanvasRenderingContext2D,
  p: RenderParams,
  pal: Palette,
  channel: number,
  top: number,
): void {
  const { buf, view, width } = p;
  const pad = 6;
  const yHi = top + pad;
  const yLo = top + p.rowHeight - pad;
  const n = buf.sampleCount;
  if (n === 0) return;

  ctx.strokeStyle = pal.trace;
  ctx.lineWidth = 1.4;
  ctx.lineJoin = "round";
  ctx.beginPath();

  let prevEndY: number | null = null;
  for (let x = 0; x < width; x++) {
    let s0 = Math.floor(xToSample(x, view));
    let s1 = Math.floor(xToSample(x + 1, view));
    if (s0 >= n) break;
    if (s0 < 0) s0 = 0;
    if (s1 <= s0) s1 = s0 + 1;
    if (s1 > n) s1 = n;

    const [mn, mx] = buf.channelMinMax(channel, s0, s1);
    const endLevel = buf.channelValueAt(channel, s1 - 1);
    const yEnd = endLevel ? yHi : yLo;
    const px = x + 0.5;

    if (prevEndY === null) {
      ctx.moveTo(px, yEnd);
    } else {
      ctx.lineTo(px, prevEndY);
      if (mn !== mx || prevEndY !== yEnd) {
        ctx.lineTo(px, yHi);
        ctx.lineTo(px, yLo);
      }
      ctx.lineTo(px, yEnd);
    }
    prevEndY = yEnd;
  }
  ctx.stroke();
}

function drawAnnotationLane(
  ctx: CanvasRenderingContext2D,
  p: RenderParams,
  pal: Palette,
  annotations: Annotation[],
  hue: number,
  top: number,
): void {
  const pad = 3;
  const yTop = top + pad;
  const boxH = p.rowHeight - pad * 2;
  ctx.font = "11px ui-monospace, monospace";
  ctx.textBaseline = "middle";

  for (const ann of annotations) {
    const x0 = sampleToX(ann.startSample, p.view);
    const x1 = sampleToX(ann.endSample, p.view);
    if (x1 < 0 || x0 > p.width) continue;

    // Zero-width events (I²C Start/Stop/ACK, 1-Wire reset, decoder warnings…)
    // carry no duration, so a duration box would be a bare 2px line with no
    // room for text. Draw them as a labelled marker centred on the sample.
    if (ann.startSample === ann.endSample) {
      drawPointMarker(ctx, pal, ann.texts, x0, yTop, boxH, hue);
      continue;
    }

    const w = Math.max(2, x1 - x0);

    ctx.fillStyle = pal.annFill(hue);
    ctx.strokeStyle = pal.annStroke;
    ctx.beginPath();
    ctx.rect(x0, yTop, w, boxH);
    ctx.fill();
    ctx.stroke();

    // Pick the longest text that fits.
    if (w > 12) {
      ctx.fillStyle = pal.annText;
      const label = pickLabel(ctx, ann.texts, w - 6);
      if (label) {
        ctx.save();
        ctx.beginPath();
        ctx.rect(x0, yTop, w, boxH);
        ctx.clip();
        ctx.fillText(label, x0 + 3, yTop + boxH / 2);
        ctx.restore();
      }
    }
  }
}

/**
 * Draw a point event (zero-width annotation) as a marker centred on its sample:
 * a stem pinning the exact position plus a rounded badge carrying the label, so
 * momentary events like I²C Start/Stop/ACK/NACK read clearly instead of as a
 * bare vertical line.
 */
function drawPointMarker(
  ctx: CanvasRenderingContext2D,
  pal: Palette,
  texts: string[],
  x: number,
  yTop: number,
  boxH: number,
  hue: number,
): void {
  const label = texts[0] ?? "";
  const badgeH = Math.min(boxH, 16);
  const badgeY = yTop + (boxH - badgeH) / 2;
  const yMid = badgeY + badgeH / 2;

  // Stem marking the exact sample, behind the badge.
  ctx.strokeStyle = pal.annMark(hue);
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(x + 0.5, yTop);
  ctx.lineTo(x + 0.5, yTop + boxH);
  ctx.stroke();

  const textW = label ? ctx.measureText(label).width : 0;
  const w = Math.max(badgeH, textW + 8);
  const bx = x - w / 2;

  ctx.fillStyle = pal.annMark(hue);
  ctx.strokeStyle = pal.annStroke;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.rect(bx, badgeY, w, badgeH);
  ctx.fill();
  ctx.stroke();

  if (label) {
    ctx.fillStyle = pal.annText;
    ctx.textAlign = "center";
    ctx.fillText(label, x, yMid);
    ctx.textAlign = "left";
  }
}

function pickLabel(
  ctx: CanvasRenderingContext2D,
  texts: string[],
  maxWidth: number,
): string | null {
  for (const t of texts) {
    if (ctx.measureText(t).width <= maxWidth) return t;
  }
  return null;
}

function drawTrigger(
  ctx: CanvasRenderingContext2D,
  p: RenderParams,
  pal: Palette,
): void {
  if (p.triggerSample === null) return;
  const x = sampleToX(p.triggerSample, p.view);
  if (x < 0 || x > p.width) return;
  ctx.strokeStyle = pal.trigger;
  ctx.lineWidth = 1;
  ctx.setLineDash([4, 3]);
  ctx.beginPath();
  ctx.moveTo(x + 0.5, 0);
  ctx.lineTo(x + 0.5, p.height);
  ctx.stroke();
  ctx.setLineDash([]);
}

function drawCursors(
  ctx: CanvasRenderingContext2D,
  p: RenderParams,
  pal: Palette,
): void {
  ctx.strokeStyle = pal.cursor;
  ctx.lineWidth = 1;
  p.cursors.forEach((sample) => {
    const x = sampleToX(sample, p.view);
    if (x < 0 || x > p.width) return;
    ctx.beginPath();
    ctx.moveTo(x + 0.5, 0);
    ctx.lineTo(x + 0.5, p.height);
    ctx.stroke();
  });
}
