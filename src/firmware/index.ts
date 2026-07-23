// Bundled fx2lafw firmware (sigrok-firmware-fx2lafw, GPLv2+). These are separate
// programs that run on the FX2 chip — shipped as data (mere aggregation), so
// bundling them does not affect this app's own license. See third-party/
// and the README for the source and license.
import cypressFx2 from "./fx2lafw-cypress-fx2.fw?url";
import saleaeLogic from "./fx2lafw-saleae-logic.fw?url";
import cwavUsbeeAx from "./fx2lafw-cwav-usbeeax.fw?url";
import cwavUsbeeDx from "./fx2lafw-cwav-usbeedx.fw?url";
import braintechUsbLps from "./fx2lafw-braintechnology-usb-lps.fw?url";
import sigrokFx28ch from "./fx2lafw-sigrok-fx2-8ch.fw?url";
import sigrokFx216ch from "./fx2lafw-sigrok-fx2-16ch.fw?url";

/** Upstream release these binaries were taken from. */
export const FIRMWARE_VERSION = "0.1.7";
/**
 * Corresponding source for the bundled binaries (GPLv2 §3). See third-party/
 * for the license texts, the upstream tarball URL, and the written offer.
 */
export const FIRMWARE_SOURCE_URL =
  "https://sigrok.org/download/source/sigrok-firmware-fx2lafw/sigrok-firmware-fx2lafw-0.1.7.tar.gz";

const URLS: Record<string, string> = {
  "fx2lafw-cypress-fx2.fw": cypressFx2,
  "fx2lafw-saleae-logic.fw": saleaeLogic,
  "fx2lafw-cwav-usbeeax.fw": cwavUsbeeAx,
  "fx2lafw-cwav-usbeedx.fw": cwavUsbeeDx,
  "fx2lafw-braintechnology-usb-lps.fw": braintechUsbLps,
  "fx2lafw-sigrok-fx2-8ch.fw": sigrokFx28ch,
  "fx2lafw-sigrok-fx2-16ch.fw": sigrokFx216ch,
};

export function hasBundledFirmware(name: string): boolean {
  return name in URLS;
}

export function bundledFirmwareNames(): string[] {
  return Object.keys(URLS);
}

/** Fetch a bundled firmware image (same-origin asset), or null if not bundled. */
export async function loadBundledFirmware(
  name: string,
): Promise<ArrayBuffer | null> {
  const url = URLS[name];
  if (!url) return null;
  const res = await fetch(url);
  if (!res.ok) return null;
  return res.arrayBuffer();
}
