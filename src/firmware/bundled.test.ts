import { describe, expect, it } from "vitest";
import { bundledFirmwareNames, hasBundledFirmware } from "./index";
import { PRE_FIRMWARE_DEVICES } from "../usb/constants";

describe("bundled firmware", () => {
  it("ships a firmware image for every auto-detectable device", () => {
    for (const d of PRE_FIRMWARE_DEVICES) {
      expect(hasBundledFirmware(d.firmware)).toBe(true);
    }
  });

  it("exposes the bundled firmware names", () => {
    expect(bundledFirmwareNames()).toContain("fx2lafw-saleae-logic.fw");
    expect(bundledFirmwareNames().length).toBeGreaterThanOrEqual(
      PRE_FIRMWARE_DEVICES.length,
    );
  });
});
