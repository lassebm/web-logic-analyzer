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
} from "../stores/session";
import { defaultConfig } from "../test/fixtures";

beforeEach(() => {
  connStatus.set("disconnected");
  captureStatus.set("idle");
  captureSamples.set(0);
  sampleSource.set("capture");
  monitorActive.set(false);
  decoders.set([]);
  config.set(defaultConfig());
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
});
