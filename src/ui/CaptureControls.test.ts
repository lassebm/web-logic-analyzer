// @vitest-environment jsdom
import { render, screen } from "@testing-library/svelte";
import { tick } from "svelte";
import { beforeEach, describe, expect, it } from "vitest";
import CaptureControls from "./CaptureControls.svelte";
import {
  connStatus,
  config,
  captureStatus,
  captureSamples,
  sampleSource,
  monitorActive,
  decoders,
  capabilities,
} from "../stores/session";
import { defaultConfig } from "../test/fixtures";
import { FX2_CAPABILITIES } from "../device/fx2";
import { SUMP_DEFAULT_CAPABILITIES } from "../device/sump";

beforeEach(() => {
  connStatus.set("disconnected");
  captureStatus.set("idle");
  captureSamples.set(0);
  sampleSource.set("capture");
  monitorActive.set(false);
  decoders.set([]);
  config.set(defaultConfig());
  capabilities.set(FX2_CAPABILITIES);
});

describe("CaptureControls", () => {
  it("disables Run until a device is ready", async () => {
    render(CaptureControls);
    const run = screen.getByRole("button", { name: "Run" });
    expect(run).toBeDisabled();
    connStatus.set("ready");
    await tick();
    expect(run).toBeEnabled();
  });

  it("disables Run while the serial monitor is active", async () => {
    connStatus.set("ready");
    render(CaptureControls);
    monitorActive.set(true);
    await tick();
    expect(screen.getByRole("button", { name: "Run" })).toBeDisabled();
  });

  it("shows the sample-count / limit readout (limit in compact units)", () => {
    render(CaptureControls);
    expect(screen.getByText(/0 \/ 1 M/)).toBeInTheDocument();
  });

  it("shows the percentage captured once samples start streaming", async () => {
    render(CaptureControls);
    // At rest (0 samples) no percentage is shown — just the raw counter.
    expect(screen.queryByText(/%/)).not.toBeInTheDocument();

    captureSamples.set(250_000); // a quarter of the 1 M default limit
    await tick();
    expect(screen.getByText(/\(25%\)/)).toBeInTheDocument();
  });

  it("shows a loaded buffer as a plain total, without limit or percentage", async () => {
    render(CaptureControls);
    // An imported buffer wasn't captured against the sample limit, so the
    // "/ limit" denominator and the percentage don't apply.
    sampleSource.set("import");
    captureSamples.set(250_000);
    await tick();
    expect(screen.getByText("Loaded")).toBeInTheDocument();
    expect(screen.getByText(/250,000 samples/)).toBeInTheDocument();
    expect(screen.queryByText(/%/)).not.toBeInTheDocument();
    expect(screen.queryByText(/\//)).not.toBeInTheDocument(); // no "N / M"
  });

  it("explains the trigger's AND semantics via an info popover", async () => {
    render(CaptureControls);
    await tick();
    const btn = screen.getByRole("button", { name: "How the trigger works" });
    expect(btn).toBeInTheDocument();
    // The toolbar has multiple InfoTips, so scope the query to this tip's own
    // popover (a sibling of its button) rather than a bare first-match.
    const tip = btn.parentElement?.querySelector('[role="tooltip"]');
    expect(tip?.textContent).toMatch(
      /all the per-channel conditions are met at once/i,
    );
  });

  it("warns when the sample rate is too low for a decoder", async () => {
    config.update((c) => ({ ...c, sampleRate: 100_000 }));
    decoders.set([
      {
        uid: "d1",
        decoderId: "uart",
        label: "UART 1",
        channelMap: [0],
        options: { baudrate: 1_000_000 },
        annotations: [],
      },
    ]);
    render(CaptureControls);
    await tick();
    expect(
      screen.getByText(/too low for the UART 1 decoder/i),
    ).toBeInTheDocument();
  });

  it("takes its rate and sample-count options from the device's capabilities", async () => {
    capabilities.set({
      ...FX2_CAPABILITIES,
      sampleRates: [200_000, 1_000_000],
      sampleLimits: [1024, 4096],
    });
    render(CaptureControls);
    await tick();

    const rate = screen.getByLabelText("Sample rate") as HTMLSelectElement;
    expect([...rate.options].map((o) => o.textContent)).toEqual([
      "200 kHz",
      "1 MHz",
    ]);
    const limit = screen.getByLabelText("Samples") as HTMLSelectElement;
    expect([...limit.options]).toHaveLength(2);
  });

  it("shows only the channels the device has", async () => {
    capabilities.set({ ...FX2_CAPABILITIES, channels: 4 });
    render(CaptureControls);
    await tick();
    expect(screen.getByRole("button", { name: "D3" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "D4" })).toBeNull();
  });

  // A one-shot device sends its samples only once the run is over, so there is
  // never anything to roll the view along with — the toggle is removed, not
  // shown dead (as with the Serial Monitor tab).
  it("hides Follow for a device that doesn't stream", async () => {
    render(CaptureControls);
    await tick();
    expect(
      screen.getByRole("checkbox", { name: "Follow" }),
    ).toBeInTheDocument();

    capabilities.set(SUMP_DEFAULT_CAPABILITIES);
    await tick();
    expect(screen.queryByRole("checkbox", { name: "Follow" })).toBeNull();
  });

  // The USB-bandwidth ceiling is an FX2 streaming concern.
  it("drops the bandwidth warning for a non-streaming device", async () => {
    config.update((c) => ({ ...c, sampleRate: 100_000_000 }));
    capabilities.set({
      ...SUMP_DEFAULT_CAPABILITIES,
      sampleRates: [100_000_000],
    });
    render(CaptureControls);
    await tick();
    expect(screen.queryByText(/USB may drop samples/i)).toBeNull();
  });
  it("offers the capture count, including an until-stopped option", async () => {
    render(CaptureControls);
    await tick();
    const sel = screen.getByLabelText("Captures") as HTMLSelectElement;
    expect(sel.value).toBe("1"); // a plain Run by default
    const labels = [...sel.options].map((o) => o.textContent?.trim());
    expect(labels).toContain("Until stopped");
    expect(labels[0]).toBe("1");
  });

  it("explains that captures are separate recordings, not one long one", async () => {
    render(CaptureControls);
    await tick();
    const btn = screen.getByRole("button", {
      name: "How repeat captures work",
    });
    const tip = btn.parentElement?.querySelector('[role="tooltip"]');
    expect(tip?.textContent).toMatch(/time between them is not recorded/i);
  });
  // Edges still work on a hardware-trigger device — they're resolved from the
  // samples afterwards — so they must stay selectable. They just behave
  // differently enough to be worth separating at the point of choice.
  it("groups trigger conditions by how the device resolves them", async () => {
    capabilities.set({ ...FX2_CAPABILITIES, hardwareTrigger: true });
    render(CaptureControls);
    await tick();

    const sel = screen.getByTitle(
      "Trigger condition for D0",
    ) as HTMLSelectElement;
    const groups = [...sel.querySelectorAll("optgroup")].map((g) => g.label);
    expect(groups).toEqual([
      "Hardware — device waits",
      "Software — found after capture",
    ]);
    // Every condition is still offered, grouped rather than removed.
    expect([...sel.options].map((o) => o.value)).toEqual([
      "off",
      "high",
      "low",
      "rising",
      "falling",
      "any",
    ]);
  });

  it("leaves the list flat when everything is resolved the same way", async () => {
    render(CaptureControls); // FX2: no hardware trigger
    await tick();

    const sel = screen.getByTitle(
      "Trigger condition for D0",
    ) as HTMLSelectElement;
    expect(sel.querySelectorAll("optgroup")).toHaveLength(0);
    expect([...sel.options]).toHaveLength(6);
  });
});
