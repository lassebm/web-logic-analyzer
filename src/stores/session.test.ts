import { afterEach, describe, expect, it } from "vitest";
import { get } from "svelte/store";
import {
  FakeUSBDevice,
  installFakeNavigatorUsb,
  type FakeNavigatorUsbHandle,
} from "../test/fakeUsb";
import {
  connect,
  disconnect,
  startCapture,
  stopCapture,
  connStatus,
  statusMessage,
  deviceLabel,
  watchUsbDisconnect,
  loadCapture,
  sampleSource,
  captureStatus,
  captureBuffer,
  config,
  decoders,
  decoderRateWarning,
  firmwareInfo,
  view,
  viewportWidth,
  type DecoderInstance,
} from "./session";
import { CaptureBuffer } from "../model/capture";
import { REQ_FIRMWARE_LOAD, CPUCS_ADDR } from "../usb/constants";
import { defaultConfig } from "../test/fixtures";

let handle: FakeNavigatorUsbHandle | null = null;

/** Remove navigator.usb entirely so Fx2Device.isSupported() is false. */
function removeNavigatorUsb(): void {
  const nav = (globalThis as { navigator?: unknown }).navigator as
    { usb?: unknown } | undefined;
  if (nav && "usb" in nav) {
    delete (nav as { usb?: unknown }).usb;
  }
}

afterEach(async () => {
  // session.ts keeps module-level `device`/`session`; reset it between tests.
  await disconnect();
  handle?.restore();
  handle = null;
  // Reset any stores we mutate so tests don't leak into each other.
  decoders.set([]);
  captureBuffer.set(null);
  captureStatus.set("idle");
  firmwareInfo.set(null);
  config.set(defaultConfig());
});

describe("session connect", () => {
  it("connects to an already-ready device (no firmware needed)", async () => {
    const fake = new FakeUSBDevice({ firmwareVersion: [1, 3], revid: 2 });
    handle = installFakeNavigatorUsb({ requestDevice: fake });

    await connect();

    expect(get(connStatus)).toBe("ready");
    expect(get(statusMessage)).toBe("Ready");
    // Label includes the firmware version reported by the device.
    expect(get(deviceLabel)).toContain("1.3");
    expect(get(deviceLabel)).toContain("rev 2");
    // The interface was claimed on the underlying device.
    expect(fake.openCalls).toBeGreaterThan(0);
    expect(fake.claimedInterfaces).toContain(0);
  });

  it("reports an error when WebUSB is unavailable", async () => {
    // Ensure navigator has no `usb` property.
    handle = installFakeNavigatorUsb({});
    handle.restore();
    handle = null;
    removeNavigatorUsb();

    await connect();

    expect(get(connStatus)).toBe("error");
    expect(get(statusMessage).toLowerCase()).toContain("webusb");
  });
});

describe("session capture", () => {
  it("fills the capture buffer up to the sample limit and finishes", async () => {
    // 5 fixed chunks of 50 bytes, then idle (queue empty -> zero-length reads).
    const chunkSize = 50;
    const chunks: Uint8Array[] = [];
    for (let i = 0; i < 5; i++) {
      chunks.push(new Uint8Array(chunkSize).fill(i + 1));
    }
    const total = chunkSize * chunks.length; // 250
    const fake = new FakeUSBDevice({
      firmwareVersion: [1, 3],
      bulkChunks: chunks,
    });
    handle = installFakeNavigatorUsb({ requestDevice: fake });

    await connect();
    expect(get(connStatus)).toBe("ready");

    config.update((c) => ({ ...c, sampleRate: 1_000_000, sampleLimit: total }));

    await startCapture();

    const buf = get(captureBuffer);
    expect(buf).not.toBeNull();
    expect(buf!.sampleCount).toBe(total);
    expect(get(captureStatus)).toBe("done");
  });

  it("stopCapture() is a no-op when nothing is running", () => {
    expect(() => stopCapture()).not.toThrow();
  });

  it("fits the finished capture to the measured viewport width", async () => {
    const chunks = [new Uint8Array(200)]; // 200 samples
    const fake = new FakeUSBDevice({
      firmwareVersion: [1, 3],
      bulkChunks: chunks,
    });
    handle = installFakeNavigatorUsb({ requestDevice: fake });
    await connect();

    viewportWidth.set(500);
    config.update((c) => ({ ...c, sampleRate: 1_000_000, sampleLimit: 200 }));
    await startCapture();

    const buf = get(captureBuffer)!;
    // spp = sampleCount / viewportWidth (200 / 500).
    expect(get(view).samplesPerPixel).toBeCloseTo(buf.sampleCount / 500, 6);
    expect(get(view).viewStart).toBe(0);
  });
});

describe("session disconnect", () => {
  it("releases and closes the device and resets status", async () => {
    const fake = new FakeUSBDevice({ firmwareVersion: [1, 3], revid: 2 });
    handle = installFakeNavigatorUsb({ requestDevice: fake });

    await connect();
    expect(get(connStatus)).toBe("ready");

    await disconnect();

    expect(get(connStatus)).toBe("disconnected");
    expect(get(deviceLabel)).toBe("");
    expect(fake.releasedInterfaces).toContain(0);
    expect(fake.closeCalls).toBeGreaterThan(0);
  });

  it("resets to disconnected when the device is unplugged (USB disconnect event)", async () => {
    const fake = new FakeUSBDevice({ firmwareVersion: [1, 3], revid: 2 });
    handle = installFakeNavigatorUsb({ requestDevice: fake });

    watchUsbDisconnect();
    await connect();
    expect(get(connStatus)).toBe("ready");

    handle.emitDisconnect(fake);

    expect(get(connStatus)).toBe("disconnected");
    expect(get(deviceLabel)).toBe("");
    expect(get(statusMessage)).toMatch(/disconnected/i);
  });

  it("ignores a disconnect event for an unrelated device", async () => {
    const fake = new FakeUSBDevice({ firmwareVersion: [1, 3], revid: 2 });
    handle = installFakeNavigatorUsb({ requestDevice: fake });

    watchUsbDisconnect();
    await connect();

    handle.emitDisconnect(new FakeUSBDevice({}));
    expect(get(connStatus)).toBe("ready");
  });

  it("keeps the partial capture and notes the loss on a mid-capture unplug", async () => {
    const fake = new FakeUSBDevice({
      firmwareVersion: [1, 3],
      bulkChunks: [new Uint8Array(50).fill(1)],
    });
    handle = installFakeNavigatorUsb({ requestDevice: fake });
    watchUsbDisconnect();
    await connect();
    config.update((c) => ({ ...c, sampleRate: 1_000_000, sampleLimit: 1_000 }));

    // Start the capture, then unplug while session.run() is still pending.
    const capture = startCapture();
    handle.emitDisconnect(fake);
    await capture;

    expect(get(connStatus)).toBe("disconnected");
    expect(get(captureBuffer)).not.toBeNull(); // capture kept, not discarded
    expect(get(captureStatus)).toBe("done");
    expect(get(statusMessage)).toMatch(/disconnect/i); // loss noted, not "Captured N"
  });
});

describe("session import", () => {
  it("loadCapture() swaps in an imported capture and marks it done", () => {
    const imported = new CaptureBuffer(2_000_000, 8);
    imported.append(new Uint8Array([1, 2, 3]));
    const ok = loadCapture(imported);

    expect(ok).toBe(true);
    const buf = get(captureBuffer);
    expect(buf?.sampleCount).toBe(3);
    expect(buf?.sampleRate).toBe(2_000_000);
    expect(get(captureStatus)).toBe("done");
    expect(get(config).sampleRate).toBe(2_000_000); // rate synced from the file
    // Marked as loaded (not a capture) so the UI drops the "% of limit" readout.
    expect(get(sampleSource)).toBe("import");
  });
});

describe("session connect (firmware upload path)", () => {
  it("uploads firmware to a pre-firmware device and connects after re-enumeration", async () => {
    // Custom firmware avoids any bundled-asset fetch inside provision().
    const fwBytes = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
    firmwareInfo.set({
      name: "custom.fw",
      size: fwBytes.length,
      data: fwBytes.buffer.slice(0),
    });

    // Pre-firmware Cypress FX2 device (needsFirmware === true).
    const preDevice = new FakeUSBDevice({
      vendorId: 0x04b4,
      productId: 0x8613,
      manufacturerName: "Cypress",
      productName: "FX2",
    });
    // Post-firmware device presenting the sigrok/fx2lafw identity.
    const postDevice = new FakeUSBDevice({ firmwareVersion: [1, 3], revid: 2 });

    // Start with no authorized devices; make the post-firmware device appear
    // during re-enumeration. Pre-populating `authorized` guarantees the 400ms
    // poll resolves even if the connect event fires before the listener; the
    // emitConnect() below makes the common case fast and deterministic.
    handle = installFakeNavigatorUsb({
      requestDevice: preDevice,
      authorized: [],
    });
    handle.authorized.push(postDevice);

    const p = connect();
    // Let the upload chain progress into waitForReenumeration(), then signal.
    await new Promise((r) => setTimeout(r, 0));
    handle.emitConnect();
    await p;

    expect(get(connStatus)).toBe("ready");

    // Firmware bytes were streamed to the pre-firmware device via REQ_FIRMWARE_LOAD.
    const loads = preDevice.controlOut.filter(
      (c) => c.request === REQ_FIRMWARE_LOAD,
    );
    expect(loads.length).toBeGreaterThanOrEqual(3); // reset-hold, chunk(s), reset-release
    const chunkWrite = loads.find(
      (c) => c.value === 0 && c.data.length === fwBytes.length,
    );
    expect(chunkWrite).toBeDefined();
    expect(Array.from(chunkWrite!.data)).toEqual(Array.from(fwBytes));
    // CPU reset was asserted and released via the CPUCS register.
    expect(loads.some((c) => c.value === CPUCS_ADDR)).toBe(true);
  });
});

describe("decoderRateWarning", () => {
  const inst = (
    label: string,
    options: Record<string, string | number>,
  ): DecoderInstance => ({
    uid: label,
    decoderId: "uart",
    label,
    channelMap: [0],
    options,
    annotations: [],
  });

  it("is null with no decoders", () => {
    decoders.set([]);
    config.update((c) => ({ ...c, sampleRate: 1_000_000 }));
    expect(get(decoderRateWarning)).toBeNull();
  });

  it("is null when the baud rate is within the safe fraction (>= 4x)", () => {
    // 1 MHz / 4 = 250k safe; 115200 baud is well under.
    decoders.set([inst("UART", { baudrate: 115200 })]);
    config.update((c) => ({ ...c, sampleRate: 1_000_000 }));
    expect(get(decoderRateWarning)).toBeNull();
  });

  it("warns when the baud rate exceeds the safe fraction of the sample rate", () => {
    // 300k baud needs >= 1.2 MHz; 1 MHz is too low.
    decoders.set([inst("UART", { baudrate: 300_000 })]);
    config.update((c) => ({ ...c, sampleRate: 1_000_000 }));
    const warning = get(decoderRateWarning);
    expect(warning).not.toBeNull();
    expect(warning).toContain("UART");
  });

  it("falls back to bitrate when there is no baudrate (e.g. CAN)", () => {
    // 500k bit/s needs >= 2 MHz; 1 MHz is too low.
    decoders.set([inst("CAN", { bitrate: 500_000 })]);
    config.update((c) => ({ ...c, sampleRate: 1_000_000 }));
    const warning = get(decoderRateWarning);
    expect(warning).not.toBeNull();
    expect(warning).toContain("CAN");
  });

  it("warns for any offending instance when several are configured", () => {
    decoders.set([
      inst("UART", { baudrate: 9600 }), // fine
      inst("CAN", { bitrate: 500_000 }), // too fast for 1 MHz
    ]);
    config.update((c) => ({ ...c, sampleRate: 1_000_000 }));
    expect(get(decoderRateWarning)).toContain("CAN");
  });
});
