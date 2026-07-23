import {
  CPUCS_ADDR,
  FW_CHUNK_SIZE,
  FX2LAFW_PRODUCT,
  POST_FIRMWARE_DEVICES,
  REQ_FIRMWARE_LOAD,
  SIGROK_MANUFACTURER,
} from "./constants";
import { Fx2Device } from "./fx2Device";

/**
 * A device needs firmware unless its string descriptors already identify it as
 * a running fx2lafw instance (manufacturer "sigrok", product "fx2lafw").
 */
export function needsFirmware(dev: Fx2Device): boolean {
  const mfr = dev.manufacturerName?.toLowerCase() ?? "";
  const prod = dev.productName?.toLowerCase() ?? "";
  return !(mfr === SIGROK_MANUFACTURER && prod === FX2LAFW_PRODUCT);
}

/** Hold (reset=1) or release (reset=0) the FX2's 8051 CPU via the CPUCS register. */
async function setCpuReset(dev: Fx2Device, held: boolean): Promise<void> {
  await dev.controlOut(
    REQ_FIRMWARE_LOAD,
    CPUCS_ADDR,
    new Uint8Array([held ? 0x01 : 0x00]),
  );
}

/**
 * Upload an fx2lafw firmware image into the FX2's RAM using the Cypress
 * bootloader: hold CPU in reset, stream the image in <=4 KB chunks to
 * ascending RAM offsets, then release reset so the 8051 boots it. The device
 * disconnects and re-enumerates with a new identity afterwards.
 */
export async function uploadFirmware(
  dev: Fx2Device,
  image: ArrayBuffer,
  onProgress?: (done: number, total: number) => void,
): Promise<void> {
  const bytes = new Uint8Array(image);
  await dev.open();
  await setCpuReset(dev, true);

  for (let offset = 0; offset < bytes.length; offset += FW_CHUNK_SIZE) {
    const chunk = bytes.subarray(
      offset,
      Math.min(offset + FW_CHUNK_SIZE, bytes.length),
    );
    await dev.controlOut(REQ_FIRMWARE_LOAD, offset, chunk);
    onProgress?.(Math.min(offset + chunk.length, bytes.length), bytes.length);
  }

  await setCpuReset(dev, false);
}

function isPostFirmware(dev: Fx2Device): boolean {
  return (
    !needsFirmware(dev) ||
    POST_FIRMWARE_DEVICES.some(
      (id) => id.vendorId === dev.vendorId && id.productId === dev.productId,
    )
  );
}

/**
 * Wait for the device to re-appear after a firmware upload. The old USBDevice
 * handle is invalidated by the re-enumeration, so we poll the authorized-device
 * list (and listen for the `connect` event) for a device that now presents an
 * fx2lafw identity.
 *
 * If the post-firmware VID:PID was not part of the originally granted
 * permission, getDevices() may not surface it (the grant is per VID:PID, and a
 * device re-enumerating to a new id counts as never-granted); on timeout the
 * caller falls back to Fx2Device.request() to let the user re-select. Re-
 * enumeration normally completes in ~1-2s and, when a grant exists, the connect
 * event resolves this well before the ceiling; the timeout is really just how
 * long the un-granted (first-run / incognito) case waits before the re-select
 * prompt, so it's kept short — but above a normal re-enumeration's worst case.
 */
export function waitForReenumeration(
  timeoutMs = 3000,
): Promise<Fx2Device | null> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: Fx2Device | null) => {
      if (settled) return;
      settled = true;
      navigator.usb.removeEventListener("connect", onConnect);
      clearInterval(poll);
      clearTimeout(timer);
      resolve(result);
    };

    const check = async () => {
      const devices = await Fx2Device.getAuthorized();
      const ready = devices.find((d) => isPostFirmware(d));
      if (ready) finish(ready);
    };

    const onConnect = () => void check();
    navigator.usb.addEventListener("connect", onConnect);

    const poll = setInterval(() => void check(), 400);
    const timer = setTimeout(() => finish(null), timeoutMs);
  });
}
