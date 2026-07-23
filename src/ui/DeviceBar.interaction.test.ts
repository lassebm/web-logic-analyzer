// @vitest-environment jsdom
import { render, screen } from "@testing-library/svelte";
import { tick } from "svelte";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import DeviceBar from "./DeviceBar.svelte";
import { connStatus, statusMessage, deviceLabel } from "../stores/session";

// DeviceBar only renders its connection UI when WebUSB is "supported"
// (navigator.usb present). jsdom has no WebUSB, so we install a minimal stub
// whose getDevices() resolves empty — that keeps onMount's tryReconnect() from
// entering the real connect/provision flow.
const usbAdded = !("usb" in navigator);
beforeEach(() => {
  if (!("usb" in navigator)) {
    Object.defineProperty(navigator, "usb", {
      configurable: true,
      value: { getDevices: async () => [] },
    });
  }
  connStatus.set("disconnected");
  statusMessage.set("");
  deviceLabel.set("");
});

afterAll(() => {
  if (usbAdded && "usb" in navigator) {
    // Leave navigator as we found it for other test files.
    delete (navigator as unknown as { usb?: unknown }).usb;
  }
});

describe("DeviceBar render states", () => {
  it("offers a Connect control when disconnected", async () => {
    render(DeviceBar);
    await tick();
    expect(
      screen.getByRole("button", { name: /connect device/i }),
    ).toBeInTheDocument();
    // No Disconnect while disconnected.
    expect(screen.queryByRole("button", { name: /disconnect/i })).toBeNull();
  });

  it("shows the device label and a Disconnect control when ready", async () => {
    connStatus.set("ready");
    deviceLabel.set("fx2lafw — fw 1.0, rev 1");
    render(DeviceBar);
    await tick();
    expect(screen.getByText(/fx2lafw — fw 1\.0, rev 1/)).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /disconnect/i }),
    ).toBeInTheDocument();
    // The Connect control is replaced by Disconnect in the ready state.
    expect(
      screen.queryByRole("button", { name: /connect device/i }),
    ).toBeNull();
  });

  it("renders the current status message", async () => {
    statusMessage.set("Ready");
    render(DeviceBar);
    await tick();
    expect(screen.getByText("Ready")).toBeInTheDocument();
  });
});
