// Assembles a stream of decoded bytes (with timestamps) into terminal lines.
// A new line starts when the gap since the previous byte exceeds gapMs, or on a
// line-feed. This is pure logic (no DOM / no USB) so it is unit-tested directly.
import { isPrintable } from "../decode/format";

/**
 * Cap on one line's length when the device never sends a line-feed. Exported so
 * the view can name the number when it marks a line it split.
 */
export const MAX_LINE_CHARS = 4096;

export interface MonitorLine {
  /** Stable identity for keyed rendering; never reused within a monitor run. */
  id: number;
  /** Time (seconds) of the first byte on the line. */
  t: number;
  /** Seconds since the previous line started (0 for the first line). */
  dt: number;
  text: string;
  /** Raw byte values on the line, in order (for the hex column). */
  bytes: number[];
  /** Time (seconds) of the most recent byte, for gap detection. */
  lastT: number;
  /**
   * True when this line exists only because the previous one hit maxLineChars,
   * i.e. it continues one logical record rather than starting a new one. The
   * view marks it and the export re-joins it, so a capped line never reads as
   * two unrelated messages.
   */
  continued: boolean;
}

/**
 * Neutralize a spreadsheet formula-injection vector before exporting terminal
 * text. A serial line beginning with `= + - @` (or a tab/CR) is executed as a
 * live formula when the exported file is opened in Excel/Sheets; prefixing a
 * single quote makes it literal text. The decoded-text column carries bytes
 * from the (untrusted) connected device, so it must be neutralized on export.
 */
export function neutralizeFormula(field: string): string {
  return /^[=+\-@\t\r]/.test(field) ? `'${field}` : field;
}

/**
 * Fold runs of `continued` lines back into the single record they were split
 * from, keeping the head's timestamps. The view shows the split (it has to — the
 * rows are what scrolls), but an export should carry logical records, so this
 * lives here rather than in the export builder: one definition of "one record"
 * for whoever needs it.
 */
export function mergeContinued(lines: MonitorLine[]): MonitorLine[] {
  const out: MonitorLine[] = [];
  for (const line of lines) {
    const head = out[out.length - 1];
    if (line.continued && head) {
      head.text += line.text;
      head.bytes = [...head.bytes, ...line.bytes];
      head.lastT = line.lastT;
    } else {
      out.push({ ...line, continued: false }); // a merged record is whole
    }
  }
  return out;
}

function displayChar(value: number): string {
  if (isPrintable(value)) return String.fromCharCode(value);
  if (value === 0x09) return "\t";
  return "·"; // placeholder for non-printable bytes
}

export class SerialTerminal {
  readonly lines: MonitorLine[] = [];
  private current: MonitorLine | null = null;
  private nextId = 0;

  constructor(
    private gapMs: number,
    private readonly maxLines = 10_000,
    private readonly maxLineChars = MAX_LINE_CHARS,
  ) {}

  setGap(ms: number): void {
    this.gapMs = ms;
  }

  clear(): void {
    this.lines.length = 0;
    this.current = null;
  }

  /**
   * End the open line — no further bytes may join it. Rebuilds its text as one
   * flat string: growing text with `+=` leaves a tree of ConsString nodes, and
   * any read of the string collapses it, so this only matters for lines nothing
   * reads — i.e. when the Text column is hidden, which is exactly the hex-only
   * binary-stream workflow that produces full-length lines. Measured on a
   * 4096-char line: ~162 KB held as an unread rope versus ~39 KB flat. Joining
   * from `bytes` reproduces the same text (displayChar is per-byte, and CR/LF
   * never reach `bytes`).
   */
  endLine(): void {
    const line = this.current;
    if (line) line.text = line.bytes.map(displayChar).join("");
    this.current = null;
  }

  /**
   * Drop the oldest lines once the scrollback is full. The O(maxLines) shift on
   * the streaming path measures 93 ns/line at a 10k cap — re-measure before
   * raising it much further, where it reaches 16 µs/line at 100k. Trimming in
   * blocks to amortize it saved nothing and made the view jump while scrolled up.
   */
  private trim(): void {
    while (this.lines.length > this.maxLines) this.lines.shift();
  }

  /** Feed one decoded byte with its timestamp (seconds). */
  feed(value: number, t: number): void {
    if (value === 0x0d) return; // ignore carriage return
    if (value === 0x0a) {
      this.endLine(); // line feed ends the current line
      return;
    }

    const gapBreak =
      this.current !== null && (t - this.current.lastT) * 1000 > this.gapMs;
    // Wrap a line with no line-feed once it reaches the cap so a device that
    // never sends 0x0a can't grow one MonitorLine's text/bytes without bound.
    const lengthBreak =
      this.current !== null && this.current.bytes.length >= this.maxLineChars;
    if (!this.current || gapBreak || lengthBreak) {
      const prev = this.lines[this.lines.length - 1];
      this.endLine();
      this.current = {
        id: this.nextId++,
        t,
        dt: prev ? t - prev.t : 0,
        text: "",
        bytes: [],
        lastT: t,
        continued: lengthBreak,
      };
      this.lines.push(this.current);
      this.trim();
    }
    this.current.text += displayChar(value);
    this.current.bytes.push(value);
    this.current.lastT = t;
  }
}
