import { CHANNEL_NAMES } from "../usb/constants";

export interface ParsedCapture {
  /** Recovered sample rate (Hz). */
  sampleRate: number;
  /** One packed byte per sample (bit c = channel Dc), as produced by capture. */
  samples: Uint8Array;
}

export type ImportFormat = "csv" | "vcd";

/** Fallback when a file has too few samples/changes to recover the rate. */
export const DEFAULT_RATE = 1_000_000;

/**
 * Upper bound on samples we will allocate for an imported capture. A malicious
 * or corrupt VCD can declare a huge `samples=` (or force a tiny GCD period), and
 * without a cap `new Uint8Array(total)` would try to allocate gigabytes and OOM
 * the tab. ~500M packed bytes — comfortably above the app's own 100M ceiling.
 */
export const MAX_SAMPLES = 500_000_000;

/**
 * Highest sample rate we accept when recovering it from a CSV time step. Above
 * this the step is implausibly small (sub-picosecond) — likely adversarial — so
 * we fall back to the default rate rather than store a nonsensical value.
 */
const MAX_RATE = 1e12;

/** VCD timescale units → picoseconds. */
const UNIT_PS: Record<string, number> = {
  fs: 1e-3,
  ps: 1,
  ns: 1e3,
  us: 1e6,
  ms: 1e9,
  s: 1e12,
};

/** Pick a format from the filename extension, else by sniffing the content. */
export function detectFormat(
  filename: string,
  text: string,
): ImportFormat | null {
  const lower = filename.toLowerCase();
  if (lower.endsWith(".vcd")) return "vcd";
  if (lower.endsWith(".csv")) return "csv";
  const head = text.slice(0, 200);
  if (/^\s*\$(date|timescale|version|comment|scope|var)\b/.test(head))
    return "vcd";
  if (/^\s*sample\s*,\s*time_s\b/.test(head)) return "csv";
  return null;
}

function splitLines(text: string): string[] {
  return text.split(/\r?\n/);
}

// --- CSV line helpers (shared by the whole-string and streaming parsers) ---

/** Parse the CSV header row into the channel index of each data column. */
export function parseCsvHeader(line: string): number[] {
  const header = line.split(",").map((s) => s.trim());
  if (header[0] !== "sample" || header[1] !== "time_s") {
    throw new Error('Unrecognized CSV header — expected "sample,time_s,…".');
  }
  const dataCols = header.slice(2);
  // Only 8 physical channels exist; a header padded with thousands of (duplicate)
  // columns would make csvRowToByte O(columns) per row — reject rather than churn.
  if (dataCols.length > CHANNEL_NAMES.length) {
    throw new Error(
      `CSV header has ${dataCols.length} channel columns; at most ${CHANNEL_NAMES.length} are supported.`,
    );
  }
  return dataCols.map((name) => {
    const ch = CHANNEL_NAMES.indexOf(name);
    if (ch < 0) throw new Error(`Unknown channel column "${name}".`);
    return ch;
  });
}

/** Pack one CSV data row into a sample byte given the header's channel columns. */
export function csvRowToByte(line: string, channelCols: number[]): number {
  const cols = line.split(",");
  let byte = 0;
  for (let j = 0; j < channelCols.length; j++) {
    if (cols[2 + j]?.trim() === "1") byte |= 1 << channelCols[j];
  }
  return byte;
}

/** The `time_s` value of a CSV data row (seconds), for rate recovery. */
export function csvRowTime(line: string): number {
  return parseFloat(line.split(",")[1]);
}

/** Recover the sample rate from the first two rows' time step. */
export function rateFromStep(t0: number, t1: number): number {
  const dt = t1 - t0;
  if (!isFinite(dt) || dt <= 0) return DEFAULT_RATE;
  const rate = Math.round(1 / dt);
  return rate > 0 && rate <= MAX_RATE ? rate : DEFAULT_RATE;
}

/** Parse a whole CSV export into packed samples (convenient for small files). */
export function parseCsv(text: string): ParsedCapture {
  const lines = splitLines(text).filter((l) => l.trim() !== "");
  if (lines.length === 0) throw new Error("The CSV file is empty.");
  const cols = parseCsvHeader(lines[0]);
  const rows = lines.slice(1);
  const samples = new Uint8Array(rows.length);
  for (let i = 0; i < rows.length; i++)
    samples[i] = csvRowToByte(rows[i], cols);
  const sampleRate =
    rows.length >= 2
      ? rateFromStep(csvRowTime(rows[0]), csvRowTime(rows[1]))
      : DEFAULT_RATE;
  return { sampleRate, samples };
}

// --- VCD accumulator (shared by the whole-string and streaming parsers) ---

function gcd(a: number, b: number): number {
  while (b) [a, b] = [b, a % b];
  return a;
}

/**
 * Consumes VCD lines one at a time (definitions then the value-change section)
 * and reconstructs packed samples on `finish()`. VCD stores value changes at
 * absolute timestamps, not a sample period, so the per-sample period is
 * recovered as the GCD of the change timestamps — exact when changes don't all
 * share a common index factor (the typical case); the file always round-trips.
 */
export class VcdAccumulator {
  private idToChannel = new Map<string, number>();
  /** Next channel handed out to a $var whose name isn't one of D0..D7. */
  private nextAutoChannel = 0;
  private unitPs = 1;
  private inDefs = true;
  private byte = 0;
  private curT = -1;
  // Value-change groups as parallel typed arrays rather than one object each:
  // a { t, byte } object costs ~88 bytes against the 9 needed here, and a VCD
  // exported from a long capture can hold tens of millions of groups.
  private snapT = new Float64Array(1024);
  private snapByte = new Uint8Array(1024);
  private snapN = 0;
  // Exact rate/length from our own $comment, when present (see the exporter).
  private metaRate = 0;
  private metaSamples = -1;
  // A $timescale whose magnitude/unit sit on following lines (common from
  // simulators and GTKWave); without this the unit silently defaulted to ps.
  private inTimescale = false;
  // Whether any value change followed the current timestamp. A trailing bare
  // timestamp (our exporter's end marker, and a common convention) bounds the
  // capture rather than being a sample of its own.
  private changedSinceT = false;

  /** Reads "1 ns" / "1ns" from a $timescale section line. True once found. */
  private readTimescale(text: string): boolean {
    const m = /(\d+)\s*(fs|ps|ns|us|ms|s)\b/.exec(text);
    if (!m) return false;
    this.unitPs = Number(m[1]) * (UNIT_PS[m[2]] ?? 1);
    return true;
  }

  line(raw: string): void {
    const line = raw.trim();
    if (this.inDefs) {
      if (line.startsWith("$timescale")) {
        this.inTimescale = !this.readTimescale(line) && !line.includes("$end");
      } else if (this.inTimescale) {
        // Keep scanning the section until its $end (or any other declaration,
        // in case the file never closes it).
        if (this.readTimescale(line) || line.includes("$end")) {
          this.inTimescale = false;
        } else if (line.startsWith("$")) {
          this.inTimescale = false;
        }
      } else if (line.startsWith("$comment")) {
        const r = /samplerate=(\d+)/.exec(line);
        const s = /samples=(\d+)/.exec(line);
        if (r) this.metaRate = Number(r[1]);
        if (s) this.metaSamples = Number(s[1]);
        // Fail on the declaration, not in finish(): a file that declares more
        // than we accept would otherwise be accumulated in full first, so the
        // limit couldn't prevent the memory blow-up it exists for.
        if (this.metaSamples > MAX_SAMPLES) this.tooLong(this.metaSamples);
      } else if (line.startsWith("$var")) {
        // $var wire 1 <id> <name> $end
        const p = line.split(/\s+/);
        const named = CHANNEL_NAMES.indexOf(p[4]);
        // Our own exports name channels D0..D7; a file from another tool names
        // them anything (clk, sda, ...) and used to map to nothing at all, so it
        // imported as eight flat traces with no error. Fall back to declaration
        // order for unrecognised names — the first eight signals become D0..D7.
        const ch = named >= 0 ? named : this.nextAutoChannel++;
        if (ch >= 0 && ch < CHANNEL_NAMES.length)
          this.idToChannel.set(p[3], ch);
      } else if (line.startsWith("$enddefinitions")) {
        this.inDefs = false;
      }
      return;
    }
    if (line === "") return;
    if (line[0] === "#") {
      if (this.curT >= 0 && this.changedSinceT)
        this.pushSnap(this.curT, this.byte);
      // A file cannot hold more change groups than samples, so this bounds an
      // undeclared file too.
      if (this.snapN > MAX_SAMPLES) this.tooLong(this.snapN);
      this.curT = Number(line.slice(1)) * this.unitPs;
      this.changedSinceT = false;
    } else {
      const bit = line[0] === "1" ? 1 : 0;
      const ch = this.idToChannel.get(line.slice(1));
      this.changedSinceT = true;
      if (ch !== undefined)
        this.byte = bit ? this.byte | (1 << ch) : this.byte & ~(1 << ch);
    }
  }

  /** Append one value-change group, growing the pair of arrays as needed. */
  private pushSnap(t: number, byte: number): void {
    if (this.snapN === this.snapT.length) {
      const grown = new Float64Array(this.snapT.length * 2);
      grown.set(this.snapT);
      this.snapT = grown;
      const grownB = new Uint8Array(this.snapByte.length * 2);
      grownB.set(this.snapByte);
      this.snapByte = grownB;
    }
    this.snapT[this.snapN] = t;
    this.snapByte[this.snapN] = byte;
    this.snapN++;
  }

  private tooLong(n: number): never {
    throw new Error(
      `VCD declares ${n} samples, over the ${MAX_SAMPLES}-sample import limit.`,
    );
  }

  finish(): ParsedCapture {
    // An unterminated final group is a sample; a bare end marker is the bound.
    let endT = -1;
    if (this.curT >= 0) {
      if (this.changedSinceT) this.pushSnap(this.curT, this.byte);
      else endT = this.curT;
    }
    const n = this.snapN;
    if (n === 0)
      return { sampleRate: DEFAULT_RATE, samples: new Uint8Array(0) };

    // Prefer the exact rate/length from our own $comment; the sample period then
    // follows from the rate. Otherwise recover the period as the GCD of the
    // change timestamps (exact unless all changes share a common index factor)
    // and derive the length from the last change.
    const haveMeta =
      Number.isFinite(this.metaRate) &&
      this.metaRate > 0 &&
      Number.isFinite(this.metaSamples) &&
      this.metaSamples >= 0;
    let period: number;
    let total: number;
    let sampleRate: number;
    if (haveMeta) {
      sampleRate = this.metaRate;
      // Guard period >= 1: a rate above 1e12 would round to 0 and make the fill
      // loop divide by zero (Infinity indices → a silently all-zero capture).
      period = Math.max(1, Math.round(1e12 / this.metaRate));
      total = this.metaSamples;
    } else {
      period = 0;
      for (let k = 0; k < n; k++) {
        const t = this.snapT[k];
        if (t > 0) period = gcd(period, t);
      }
      const hasRate = period > 0;
      if (!hasRate) period = 1; // only #0 — a single sample
      total =
        endT >= 0
          ? Math.floor(endT / period)
          : Math.floor(this.snapT[n - 1] / period) + 1;
      sampleRate = hasRate ? Math.round(1e12 / period) : DEFAULT_RATE;
    }

    // Reject an implausible/adversarial length before allocating — a tiny file
    // can otherwise declare (or imply via a small period) gigabytes of samples.
    if (!Number.isFinite(total) || total < 0) {
      throw new Error("VCD declares an invalid sample count.");
    }
    if (total > MAX_SAMPLES) {
      throw new Error(
        `VCD declares ${total} samples, over the ${MAX_SAMPLES}-sample import limit.`,
      );
    }

    const samples = new Uint8Array(total);
    for (let k = 0; k < n; k++) {
      const start = Math.min(Math.floor(this.snapT[k] / period), total);
      const end =
        k + 1 < n
          ? Math.min(Math.floor(this.snapT[k + 1] / period), total)
          : total;
      samples.fill(this.snapByte[k], start, end);
    }
    return {
      sampleRate,
      samples,
    };
  }
}

/** Parse a whole VCD export into packed samples (convenient for small files). */
export function parseVcd(text: string): ParsedCapture {
  const acc = new VcdAccumulator();
  for (const line of splitLines(text)) acc.line(line);
  return acc.finish();
}

/** Parse a whole CSV or VCD export by format (convenient for small files and tests;
 * the app imports via the streaming `importFile`). */
export function parseCapture(
  format: ImportFormat,
  text: string,
): ParsedCapture {
  return format === "vcd" ? parseVcd(text) : parseCsv(text);
}
