import { describe, expect, it } from "vitest";
import { SerialTerminal, neutralizeFormula } from "./terminal";

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

  it("wraps a line with no line-feed once it hits the char cap", () => {
    const t = new SerialTerminal(1000, 2000, 4); // maxLineChars = 4
    let time = 0;
    for (const c of "abcdefghij") t.feed(ch(c), (time += 0.001));
    expect(t.lines.map((l) => l.text)).toEqual(["abcd", "efgh", "ij"]);
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
