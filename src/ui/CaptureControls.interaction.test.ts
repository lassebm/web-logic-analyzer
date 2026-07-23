// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/svelte";
import { tick } from "svelte";
import { get } from "svelte/store";
import { beforeEach, describe, expect, it } from "vitest";
import CaptureControls from "./CaptureControls.svelte";
import {
  config,
  connStatus,
  captureStatus,
  captureSamples,
  monitorActive,
  decoders,
} from "../stores/session";
import { CHANNEL_NAMES } from "../usb/constants";
import { defaultConfig } from "../test/fixtures";

beforeEach(() => {
  connStatus.set("ready");
  captureStatus.set("idle");
  captureSamples.set(0);
  monitorActive.set(false);
  decoders.set([]);
  config.set(defaultConfig());
});

describe("CaptureControls interactions", () => {
  it("toggles a channel on and off via its chip button", async () => {
    render(CaptureControls);
    const chip = screen.getByRole("button", { name: CHANNEL_NAMES[0] }); // 'D0'

    expect(get(config).enabledChannels[0]).toBe(true);
    await fireEvent.click(chip);
    expect(get(config).enabledChannels[0]).toBe(false);
    // Other channels are untouched.
    expect(get(config).enabledChannels[1]).toBe(true);

    await fireEvent.click(chip);
    expect(get(config).enabledChannels[0]).toBe(true);
  });

  it("toggles all channels off then on via the All/None quick actions", async () => {
    render(CaptureControls);
    expect(get(config).enabledChannels.every((c) => c)).toBe(true);

    await fireEvent.click(screen.getByRole("button", { name: "None" }));
    expect(get(config).enabledChannels.every((c) => !c)).toBe(true);

    // Pick just one, then "All" restores every channel.
    await fireEvent.click(
      screen.getByRole("button", { name: CHANNEL_NAMES[1] }),
    );
    expect(get(config).enabledChannels).toEqual([
      false,
      true,
      false,
      false,
      false,
      false,
      false,
      false,
    ]);

    await fireEvent.click(screen.getByRole("button", { name: "All" }));
    expect(get(config).enabledChannels.every((c) => c)).toBe(true);
  });

  it("shows a trigger Clear only when set, and it resets every condition", async () => {
    render(CaptureControls);
    // No conditions -> no Clear affordance.
    expect(screen.queryByRole("button", { name: "Clear" })).toBeNull();

    // Arm two channels, then Clear wipes them all at once.
    await fireEvent.change(
      screen.getByTitle("Software trigger condition for D0"),
      { target: { value: "rising" } },
    );
    await fireEvent.change(
      screen.getByTitle("Software trigger condition for D2"),
      { target: { value: "falling" } },
    );
    expect(get(config).trigger.conditions).toHaveLength(2);

    await fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    expect(get(config).trigger.conditions).toHaveLength(0);
    expect(screen.queryByRole("button", { name: "Clear" })).toBeNull();
  });

  it("sets and clears a per-channel software trigger via the edge select", async () => {
    render(CaptureControls);
    const select = screen.getByTitle(
      "Software trigger condition for D0",
    ) as HTMLSelectElement;

    // Starts with no conditions.
    expect(get(config).trigger.conditions).toHaveLength(0);

    // setEdge add branch: choosing an edge adds a condition for channel 0.
    await fireEvent.change(select, { target: { value: "rising" } });
    expect(get(config).trigger.conditions).toContainEqual({
      channel: 0,
      edge: "rising",
    });

    // edgeFor should reflect the stored edge on the control.
    expect(select.value).toBe("rising");

    // setEdge remove branch: choosing 'off' removes the condition for channel 0.
    await fireEvent.change(select, { target: { value: "off" } });
    expect(get(config).trigger.conditions.some((c) => c.channel === 0)).toBe(
      false,
    );
  });

  it("replaces (does not duplicate) a channel trigger when the edge changes", async () => {
    render(CaptureControls);
    const select = screen.getByTitle(
      "Software trigger condition for D0",
    ) as HTMLSelectElement;

    await fireEvent.change(select, { target: { value: "rising" } });
    await fireEvent.change(select, { target: { value: "falling" } });

    const forCh0 = get(config).trigger.conditions.filter(
      (c) => c.channel === 0,
    );
    expect(forCh0).toEqual([{ channel: 0, edge: "falling" }]);
  });

  it("shows the capture duration derived from sampleLimit / sampleRate", () => {
    // 1,000,000 samples at 1,000,000 samples/s ≈ 1 s.
    render(CaptureControls);
    const duration = screen.getByTitle(
      /Time to capture the full sample count/i,
    );
    expect(duration.textContent?.replace(/\s+/g, " ").trim()).toBe("≈ 1 s");
  });

  it("updates the duration readout when the config changes", async () => {
    render(CaptureControls);
    const duration = screen.getByTitle(
      /Time to capture the full sample count/i,
    );

    config.set(defaultConfig({ sampleLimit: 10_000 }));
    // 10,000 / 1,000,000 = 0.01 s = 10 ms.
    await tick();
    expect(duration.textContent?.replace(/\s+/g, " ").trim()).toBe("≈ 10 ms");
  });
});
