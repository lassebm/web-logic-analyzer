// @vitest-environment jsdom
import { render, screen } from "@testing-library/svelte";
import { describe, expect, it } from "vitest";
import DeviceBar from "./DeviceBar.svelte";

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
});
