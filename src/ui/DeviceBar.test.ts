// @vitest-environment jsdom
import { render, screen } from "@testing-library/svelte";
import { afterEach, describe, expect, it } from "vitest";
import DeviceBar from "./DeviceBar.svelte";
import { connStatus } from "../stores/session";
import {
  installFakeNavigatorUsb,
  type FakeNavigatorUsbHandle,
} from "../test/fakeUsb";

let handle: FakeNavigatorUsbHandle | null = null;

afterEach(() => {
  handle?.restore();
  handle = null;
  connStatus.set("disconnected");
});

describe("DeviceBar", () => {
  it("shows a WebUSB-unavailable message when navigator.usb is missing", () => {
    // jsdom has no navigator.usb, so the app should tell the user WebUSB is unavailable.
    render(DeviceBar);
    expect(screen.getByText(/WebUSB unavailable/i)).toBeInTheDocument();
    // The Connect button should not be offered.
    expect(
      screen.queryByRole("button", { name: /connect device/i }),
    ).toBeNull();
  });

  it("offers a Finish connecting button in the reselect state", () => {
    // After a firmware upload whose device couldn't auto-reconnect, the bar
    // should surface the one-click finish action instead of a generic Connect.
    handle = installFakeNavigatorUsb({ authorized: [] });
    connStatus.set("reselect");
    render(DeviceBar);
    expect(
      screen.getByRole("button", { name: /finish connecting/i }),
    ).toBeInTheDocument();
    // The generic Connect button is replaced, not shown alongside it.
    expect(
      screen.queryByRole("button", { name: /connect device/i }),
    ).toBeNull();
  });
});
