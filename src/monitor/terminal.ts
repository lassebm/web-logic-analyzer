// Assembles a stream of decoded bytes (with timestamps) into terminal lines.
// A new line starts when the gap since the previous byte exceeds gapMs, or on a
// line-feed. This is pure logic (no DOM / no USB) so it is unit-tested directly.
import { isPrintable } from "../decode/format";

export interface MonitorLine {
  /** Time (seconds) of the first byte on the line. */
  t: number;
  text: string;
  /** Raw byte values on the line, in order (for the hex column). */
  bytes: number[];
  /** Time (seconds) of the most recent byte, for gap detection. */
  lastT: number;
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

function displayChar(value: number): string {
  if (isPrintable(value)) return String.fromCharCode(value);
  if (value === 0x09) return "\t";
  return "·"; // placeholder for non-printable bytes
}

export class SerialTerminal {
  readonly lines: MonitorLine[] = [];
  private current: MonitorLine | null = null;

  constructor(
    private gapMs: number,
    private readonly maxLines = 2000,
    private readonly maxLineChars = 4096,
  ) {}

  setGap(ms: number): void {
    this.gapMs = ms;
  }

  clear(): void {
    this.lines.length = 0;
    this.current = null;
  }

  /** Feed one decoded byte with its timestamp (seconds). */
  feed(value: number, t: number): void {
    if (value === 0x0d) return; // ignore carriage return
    if (value === 0x0a) {
      // line feed ends the current line
      this.current = null;
      return;
    }

    const gapBreak =
      this.current !== null && (t - this.current.lastT) * 1000 > this.gapMs;
    // Wrap a line with no line-feed once it reaches the cap so a device that
    // never sends 0x0a can't grow one MonitorLine's text/bytes without bound.
    const lengthBreak =
      this.current !== null && this.current.text.length >= this.maxLineChars;
    if (!this.current || gapBreak || lengthBreak) {
      this.current = { t, text: "", bytes: [], lastT: t };
      this.lines.push(this.current);
      if (this.lines.length > this.maxLines) this.lines.shift();
    }
    this.current.text += displayChar(value);
    this.current.bytes.push(value);
    this.current.lastT = t;
  }
}
