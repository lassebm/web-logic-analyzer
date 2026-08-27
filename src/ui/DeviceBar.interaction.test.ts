// @vitest-environment jsdom
import { render, screen } from "@testing-library/svelte";
import { get } from "svelte/store";
import { tick } from "svelte";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import DeviceBar from "./DeviceBar.svelte";
import {
  connStatus,
  statusMessage,
  deviceLabel,
  backendId,
  setBackend,
} from "../stores/session";

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
  setBackend("fx2");
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

  // A SUMP device's label is much longer than an FX2's, so it can still outrun
  // the bar on a narrow window — the full text has to stay reachable rather
  // than being silently clipped to "…262".
  it("keeps the whole device label available when it is too long to show", async () => {
    const long = "ESP32-C3 SUMP emulator — 8 channels, 262,144 samples";
    connStatus.set("ready");
    deviceLabel.set(long);
    render(DeviceBar);
    await tick();
    expect(screen.getByText(long)).toHaveAttribute("title", long);
  });

  it("offers a backend selector, enabled only while disconnected", async () => {
    render(DeviceBar);
    await tick();
    const select = screen.getByLabelText("Device") as HTMLSelectElement;
    expect(select).toBeEnabled();
    expect([...select.options].map((o) => o.value)).toEqual(["fx2", "sump"]);
    expect(select.value).toBe("fx2");

    // Switching families mid-connection would strand the connected device.
    connStatus.set("ready");
    await tick();
    expect(select).toBeDisabled();
  });

  it("hides the Firmware chip for a backend that has no firmware to load", async () => {
    render(DeviceBar);
    await tick();
    expect(
      screen.getByRole("button", { name: /^Firmware:/ }),
    ).toBeInTheDocument();

    setBackend("sump");
    await tick();
    expect(screen.queryByRole("button", { name: /^Firmware:/ })).toBeNull();
    expect(get(backendId)).toBe("sump");
  });
});
