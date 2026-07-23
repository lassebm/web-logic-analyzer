// @vitest-environment jsdom
import { render, screen, fireEvent } from "@testing-library/svelte";
import { tick } from "svelte";
import { beforeEach, describe, expect, it } from "vitest";
import { get } from "svelte/store";
import SerialMonitor from "./SerialMonitor.svelte";
import { connStatus, captureStatus } from "../stores/session";
import { monitorConfig, monitorActive, monitorLines } from "../stores/monitor";

beforeEach(() => {
  connStatus.set("disconnected");
  captureStatus.set("idle");
  monitorActive.set(false);
  monitorLines.set([]);
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

  it("requires a second click to clear (confirmable)", async () => {
    render(SerialMonitor);
    await fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    expect(
      screen.getByRole("button", { name: "Confirm clear?" }),
    ).toBeInTheDocument();
  });
});
