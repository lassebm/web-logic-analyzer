// @vitest-environment jsdom
import { render, screen, fireEvent } from "@testing-library/svelte";
import { tick } from "svelte";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { get } from "svelte/store";
import SerialMonitor from "./SerialMonitor.svelte";
import { connStatus, captureStatus, capabilities } from "../stores/session";
import { FX2_CAPABILITIES } from "../device/fx2";
import { monitorConfig, monitorActive, monitorLines } from "../stores/monitor";
import { monitorLine } from "../test/fixtures";

beforeEach(() => {
  connStatus.set("disconnected");
  captureStatus.set("idle");
  monitorActive.set(false);
  monitorLines.set([]);
  capabilities.set(FX2_CAPABILITIES);
  monitorConfig.set({
    channel: 0,
    baud: 115200,
    dataBits: 8,
    parity: "none",
    stopBits: 1,
    bitOrder: "lsb-first",
    invert: "no",
    newlineOnIdle: true,
    gapMs: 50,
    showText: true,
    showHex: false,
    tsWall: false,
    tsFromStart: true,
    tsSinceLast: false,
  });
});

describe("SerialMonitor", () => {
  it("shows the effective sample rate for the baud", () => {
    render(SerialMonitor);
    // 115200 baud -> ~8x -> 1 MHz
    expect(screen.getByText(/Sample rate: 1 MHz/)).toBeInTheDocument();
  });

  it("baud is a preset dropdown that also accepts a custom value", async () => {
    render(SerialMonitor);
    const baud = screen.getByLabelText("Baud") as HTMLSelectElement;
    expect(baud.tagName).toBe("SELECT");
    expect(baud.querySelectorAll("option").length).toBeGreaterThan(8);

    // "Custom…" swaps to a text field; a typed baud commits on blur.
    const customValue = [...baud.options].find(
      (o) => o.text === "Custom…",
    )!.value;
    await fireEvent.change(baud, { target: { value: customValue } });
    await tick();
    const input = screen.getByLabelText("Baud") as HTMLInputElement;
    expect(input.tagName).toBe("INPUT");
    await fireEvent.change(input, { target: { value: "250000" } });
    await fireEvent.blur(input);
    expect(get(monitorConfig).baud).toBe(250000);
  });

  it('disables the idle-gap input when "New line after idle" is off', async () => {
    monitorConfig.update((c) => ({ ...c, newlineOnIdle: false }));
    render(SerialMonitor);
    await tick();
    expect(screen.getByDisplayValue("50")).toBeDisabled();
  });

  it("requires a second click to clear a log (confirmable)", async () => {
    monitorLines.set([monitorLine("hi")]);
    render(SerialMonitor);
    await fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    expect(
      screen.getByRole("button", { name: "Confirm clear?" }),
    ).toBeInTheDocument();
  });

  it("clears an empty log without asking — nothing to lose", async () => {
    render(SerialMonitor);
    await fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    expect(screen.getByRole("button", { name: "Clear" })).toBeInTheDocument();
  });

  // Starting wipes the lines, so it asks first once there are some.
  it("confirms before a Start discards the shown log", async () => {
    connStatus.set("ready");
    monitorLines.set([monitorLine("hi")]);
    render(SerialMonitor);

    await fireEvent.click(screen.getByRole("button", { name: "Start" }));

    expect(
      screen.getByRole("button", { name: "Confirm start?" }),
    ).toBeInTheDocument();
    expect(get(monitorActive)).toBe(false); // not started yet
  });

  it("starts straight away when there is no log to discard", async () => {
    connStatus.set("ready");
    render(SerialMonitor);
    expect(screen.getByRole("button", { name: "Start" })).toBeEnabled();
    // No arming step: the label stays "Start" (startMonitor() needs a device,
    // so the click is a no-op here beyond proving it wasn't intercepted).
    await fireEvent.click(screen.getByRole("button", { name: "Start" }));
    expect(screen.getByRole("button", { name: "Start" })).toBeInTheDocument();
  });

  // A device that never sends a line-feed gets its line split at the char cap.
  // Unmarked, the split reads as two unrelated messages.
  it("marks a cap-split line as continuing the one above", async () => {
    monitorLines.set([
      monitorLine("abcd"),
      monitorLine("efg", { continued: true }),
    ]);
    render(SerialMonitor);
    await tick();
    expect(screen.getAllByLabelText("continued line")).toHaveLength(1);
  });

  it("leaves ordinary lines unmarked", async () => {
    monitorLines.set([monitorLine("abcd"), monitorLine("efg")]);
    render(SerialMonitor);
    await tick();
    expect(screen.queryByLabelText("continued line")).not.toBeInTheDocument();
  });

  it("re-joins a cap-split line into one row on export", async () => {
    const writeText = vi.fn(async (_text: string) => {});
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
    monitorConfig.update((c) => ({ ...c, showHex: true, showText: true }));
    monitorLines.set([
      monitorLine("abcd"),
      monitorLine("efg", { continued: true }),
    ]);
    render(SerialMonitor);

    await fireEvent.click(screen.getByRole("button", { name: "Copy" }));
    await vi.waitFor(() => expect(writeText).toHaveBeenCalled());

    const [header, ...rows] = writeText.mock.calls[0][0].split("\n");
    expect(header).toBe("from_start\thex\ttext");
    expect(rows).toHaveLength(1); // one logical record, not two
    expect(rows[0]).toBe("0.000s\t61 62 63 64 65 66 67\tabcdefg");
  });

  // Rows re-render on item identity, so publishLines() gives the growing line a
  // fresh object each tick. Same id, new object — the row must follow it.
  it("updates the row of the line still being received", async () => {
    const open = monitorLine("ab");
    monitorLines.set([open]);
    render(SerialMonitor);
    await tick();
    expect(screen.getByText("ab")).toBeInTheDocument();

    monitorLines.set([{ ...open, text: "abc", bytes: [97, 98, 99] }]);
    await tick();
    expect(screen.getByText("abc")).toBeInTheDocument();
    expect(screen.queryByText("ab")).not.toBeInTheDocument();
  });

  // The hex memo is keyed on the line object plus its byte count, so neither a
  // longer copy nor a re-publish may serve a stale string.
  it("refreshes the hex column as the open line grows", async () => {
    monitorConfig.update((c) => ({ ...c, showHex: true, showText: false }));
    const open = monitorLine("ab");
    monitorLines.set([open]);
    render(SerialMonitor);
    await tick();
    expect(screen.getByText("61 62")).toBeInTheDocument();

    monitorLines.set([{ ...open, bytes: [97, 98, 99] }]);
    await tick();
    expect(screen.getByText("61 62 63")).toBeInTheDocument();
  });

  // Unchanged rows must not re-render when a line is appended — the scrollback
  // is up to 10k rows and the poll runs 12x a second (see `rows` in the view).
  it("re-renders only the changed row on a publish", async () => {
    let reads = 0;
    const lines = Array.from({ length: 50 }, (_, i) => {
      const line = monitorLine(`line ${i}`);
      let t = i * 0.01;
      Object.defineProperty(line, "t", {
        get: () => (reads++, t),
        set: (v: number) => (t = v),
        enumerable: true,
      });
      return line;
    });
    monitorLines.set(lines.slice());
    render(SerialMonitor);
    await tick();

    reads = 0;
    monitorLines.set([...lines, monitorLine("new")]);
    await tick();
    expect(reads).toBe(0); // none of the 50 existing rows re-read their fields
  });

  it("lists only the channels the device has", async () => {
    capabilities.set({ ...FX2_CAPABILITIES, channels: 4 });
    render(SerialMonitor);
    await tick();
    const channel = screen.getByLabelText("Ch") as HTMLSelectElement;
    expect([...channel.options].map((o) => o.textContent)).toEqual([
      "D0",
      "D1",
      "D2",
      "D3",
    ]);
  });
});
