import { describe, expect, it } from "vitest";
import { SerialTerminal, neutralizeFormula, mergeContinued } from "./terminal";
import { monitorLine } from "../test/fixtures";

const ch = (s: string) => s.charCodeAt(0);

describe("SerialTerminal", () => {
  it("groups bytes into one line while within the gap", () => {
    const t = new SerialTerminal(50);
    let time = 0;
    for (const c of "Hello") t.feed(ch(c), (time += 0.001));
    expect(t.lines.length).toBe(1);
    expect(t.lines[0].text).toBe("Hello");
  });

  it("starts a new line after a pause longer than the gap", () => {
    const t = new SerialTerminal(50); // 50 ms
    t.feed(ch("A"), 0.0);
    t.feed(ch("B"), 0.01); // +10 ms -> same line
    t.feed(ch("C"), 0.2); // +190 ms -> new line
    expect(t.lines.map((l) => l.text)).toEqual(["AB", "C"]);
    expect(t.lines[1].t).toBeCloseTo(0.2, 6);
  });

  it("breaks lines on line-feed and ignores carriage return", () => {
    const t = new SerialTerminal(1000);
    let time = 0;
    for (const c of "ab") t.feed(ch(c), (time += 0.001));
    t.feed(0x0d, (time += 0.001)); // CR ignored
    t.feed(0x0a, (time += 0.001)); // LF ends line
    for (const c of "cd") t.feed(ch(c), (time += 0.001));
    expect(t.lines.map((l) => l.text)).toEqual(["ab", "cd"]);
  });

  it("renders non-printable bytes as a placeholder", () => {
    const t = new SerialTerminal(1000);
    t.feed(0x01, 0);
    expect(t.lines[0].text).toBe("·");
  });

  it("records raw byte values per line for the hex column", () => {
    const t = new SerialTerminal(1000);
    t.feed(0x48, 0);
    t.feed(0x00, 0.001); // non-printable -> '·' in text, 0x00 in bytes
    t.feed(0x69, 0.002);
    expect(t.lines[0].bytes).toEqual([0x48, 0x00, 0x69]);
    expect(t.lines[0].text).toBe("H·i");
  });

  it("applies a new gap threshold via setGap() to subsequent bytes", () => {
    const t = new SerialTerminal(50); // 50 ms
    t.feed(ch("A"), 0.0);
    t.setGap(200); // widen the gap so a 100 ms pause no longer breaks
    t.feed(ch("B"), 0.1); // +100 ms -> under 200 ms, same line
    expect(t.lines.map((l) => l.text)).toEqual(["AB"]);
    t.setGap(20); // tighten so the same 100 ms pause now breaks
    t.feed(ch("C"), 0.2); // +100 ms -> over 20 ms, new line
    expect(t.lines.map((l) => l.text)).toEqual(["AB", "C"]);
  });

  it("caps the number of retained lines", () => {
    const t = new SerialTerminal(0, 3); // gap 0 -> every byte its own line
    for (let i = 0; i < 10; i++) t.feed(ch("x"), i);
    expect(t.lines.length).toBe(3);
  });

  it("keeps the newest lines when trimming to the cap", () => {
    const t = new SerialTerminal(0, 64); // gap 0 -> every byte its own line
    for (let i = 0; i < 500; i++) t.feed(ch("x"), i);
    expect(t.lines.length).toBe(64);
    // The survivors are the last 64 fed, in order — not an arbitrary window.
    expect(t.lines.map((l) => l.id)).toEqual(
      Array.from({ length: 64 }, (_, i) => 436 + i),
    );
  });

  it("gives every line a stable, unique id for keyed rendering", () => {
    const t = new SerialTerminal(0);
    for (let i = 0; i < 5; i++) t.feed(ch("x"), i);
    const ids = t.lines.map((l) => l.id);
    expect(new Set(ids).size).toBe(ids.length);
    // Ids survive further feeding — the view keys on them.
    const first = t.lines[0];
    t.feed(ch("y"), 99);
    expect(t.lines[0]).toBe(first);
    expect(t.lines[0].id).toBe(first.id);
  });

  it("records the gap since the previous line started", () => {
    const t = new SerialTerminal(50);
    t.feed(ch("A"), 0.0);
    t.feed(ch("B"), 0.5); // new line, 0.5 s after the previous line started
    t.feed(ch("C"), 1.25);
    expect(t.lines.map((l) => l.dt)).toEqual([0, 0.5, 0.75]);
  });

  it("wraps a line with no line-feed once it hits the char cap", () => {
    const t = new SerialTerminal(1000, 2000, 4); // maxLineChars = 4
    let time = 0;
    for (const c of "abcdefghij") t.feed(ch(c), (time += 0.001));
    expect(t.lines.map((l) => l.text)).toEqual(["abcd", "efgh", "ij"]);
  });

  it("marks a cap-split line as continued, but not a real new line", () => {
    const t = new SerialTerminal(1000, 2000, 4);
    let time = 0;
    for (const c of "abcdefg") t.feed(ch(c), (time += 0.001));
    t.feed(0x0a, (time += 0.001)); // line-feed: the next line is genuinely new
    t.feed(ch("z"), time + 0.001);
    expect(t.lines.map((l) => [l.text, l.continued])).toEqual([
      ["abcd", false],
      ["efg", true],
      ["z", false],
    ]);
  });

  it("a gap-broken line is not marked continued", () => {
    const t = new SerialTerminal(50);
    t.feed(ch("A"), 0.0);
    t.feed(ch("B"), 0.2); // gap break
    expect(t.lines.map((l) => l.continued)).toEqual([false, false]);
  });

  // endLine() rebuilds a finished line's text from its bytes to drop the
  // ConsString rope that `+=` leaves behind; the text must come out identical.
  it("keeps a closed line's text identical to the incrementally built one", () => {
    const bytes = [0x48, 0x00, 0x09, 0x7e, 0x69, 0xff];
    const open = new SerialTerminal(1000);
    const closed = new SerialTerminal(1000);
    let time = 0;
    for (const b of bytes) {
      const at = (time += 0.001);
      open.feed(b, at);
      closed.feed(b, at);
    }
    const incremental = open.lines[0].text; // still open, built with `+=`
    closed.endLine(); // rebuilt from bytes
    expect(closed.lines[0].text).toBe(incremental);
    expect(closed.lines[0].text).toBe("H·\t~i·");
  });

  it("endLine() ends the open line so later bytes start a new one", () => {
    const t = new SerialTerminal(10_000); // gap wide enough not to break
    t.feed(ch("a"), 0);
    t.endLine();
    t.feed(ch("b"), 0.001);
    expect(t.lines.map((l) => l.text)).toEqual(["a", "b"]);
  });
});

describe("mergeContinued", () => {
  it("folds a run of continuations into the line they were split from", () => {
    const merged = mergeContinued([
      monitorLine("abcd", { t: 1, dt: 0.5, lastT: 1.1 }),
      monitorLine("efgh", { continued: true, t: 1.1, lastT: 1.2 }),
      monitorLine("ij", { continued: true, t: 1.2, lastT: 1.3 }),
      monitorLine("next", { t: 9, dt: 7.7 }),
    ]);
    expect(merged.map((l) => l.text)).toEqual(["abcdefghij", "next"]);
    expect(merged[0].bytes).toEqual(
      [..."abcdefghij"].map((c) => c.charCodeAt(0)),
    );
    // The head's start time and gap survive; its end moves to the last fragment.
    expect(merged[0].t).toBe(1);
    expect(merged[0].dt).toBe(0.5);
    expect(merged[0].lastT).toBe(1.3);
    expect(merged.every((l) => !l.continued)).toBe(true);
  });

  it("leaves ordinary lines alone and never mutates the input", () => {
    const lines = [monitorLine("a"), monitorLine("b")];
    const merged = mergeContinued(lines);
    expect(merged.map((l) => l.text)).toEqual(["a", "b"]);
    expect(merged[0]).not.toBe(lines[0]); // copies, so callers can't corrupt the log
  });

  // Can't happen from SerialTerminal (the first line is never a continuation),
  // but an imported/edited log shouldn't drop its first record.
  it("keeps a leading continuation rather than discarding it", () => {
    const merged = mergeContinued([monitorLine("orphan", { continued: true })]);
    expect(merged.map((l) => l.text)).toEqual(["orphan"]);
  });
});

describe("neutralizeFormula", () => {
  it("prefixes a quote when text starts with a spreadsheet formula trigger", () => {
    for (const s of ["=1+1", "+A1", "-2", "@SUM(1)", "\tx", "\rx"]) {
      expect(neutralizeFormula(s)).toBe(`'${s}`);
    }
  });

  it("leaves ordinary text unchanged", () => {
    expect(neutralizeFormula("Hello")).toBe("Hello");
    expect(neutralizeFormula("3.3V")).toBe("3.3V");
    expect(neutralizeFormula("")).toBe("");
  });
});
