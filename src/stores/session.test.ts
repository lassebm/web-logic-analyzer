import { afterEach, describe, expect, it, vi } from "vitest";
import { get } from "svelte/store";
import {
  FakeUSBDevice,
  installFakeNavigatorUsb,
  type FakeNavigatorUsbHandle,
} from "../test/fakeUsb";
import {
  FakeSerialPort,
  installFakeNavigatorSerial,
  metadataBytes,
  reversedDump,
  sumpResponses,
  type FakeNavigatorSerialHandle,
} from "../test/fakeSerial";
import {
  connect,
  finishConnect,
  disconnect,
  startCapture,
  stopCapture,
  connStatus,
  statusMessage,
  deviceLabel,
  watchDeviceDisconnect,
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
  backendId,
  capabilities,
  captures,
  captureCursor,
  capturePosition,
  selectCapture,
  stepCapture,
  trimRetained,
  triggerSample,
  unsavedCapture,
  capturedSamples,
  CAPTURES_UNTIL_STOPPED,
  type CaptureRecord,
  setBackend,
  connectedDevice,
  type DecoderInstance,
} from "./session";
import { getBackend } from "../device/registry";
import { CaptureBuffer } from "../model/capture";
import { REQ_FIRMWARE_LOAD, CPUCS_ADDR } from "../usb/constants";
import { defaultConfig } from "../test/fixtures";
import { uartBytes } from "../test/waveforms";

let handle: FakeNavigatorUsbHandle | null = null;
let serialHandle: FakeNavigatorSerialHandle | null = null;

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
  setBackend("fx2"); // backend selection is module state too
  handle?.restore();
  handle = null;
  serialHandle?.restore();
  serialHandle = null;
  // Reset any stores we mutate so tests don't leak into each other.
  decoders.set([]);
  captureBuffer.set(null);
  captureStatus.set("idle");
  captures.set([]);
  captureCursor.set(0);
  firmwareInfo.set(null);
  config.set(defaultConfig());
});

/** A SUMP device that answers CMD_RUN for the first `n` captures, then goes
 *  quiet — which is what a device still filling its memory looks like. */
function quietAfter(n: number, samples: number[]): FakeSerialPort {
  let runs = 0;
  return new FakeSerialPort({
    respond: {
      0x02: new Uint8Array([0x31, 0x41, 0x4c, 0x53]),
      0x04: metadataBytes("ESP32-BP SUMP", [
        [0x20, 8],
        [0x21, 4096],
      ]),
      0x01: () => (runs++ < n ? reversedDump(samples) : null),
    },
  });
}

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

  // Blocking the page mid-capture (the leave-site prompt, say) kills the FX2
  // stream for good: the endpoint goes quiet and the read never settles. The
  // capture must end itself with the samples it got — it used to sit on
  // "running" with the Stop button up, looking hung.
  it("ends a capture whose stream goes quiet, keeping the partial samples", async () => {
    const fake = new FakeUSBDevice({
      firmwareVersion: [1, 3],
      bulkChunks: [new Uint8Array(100)],
      bulkHangsWhenDry: true,
    });
    handle = installFakeNavigatorUsb({ requestDevice: fake });
    await connect();

    config.update((c) => ({ ...c, sampleRate: 1_000_000, sampleLimit: 1e6 }));

    vi.useFakeTimers();
    try {
      const capture = startCapture();
      // Past the stall timeout with no data (the default is derived from the
      // rate; 1 MHz with 64 KB transfers lands on the 3 s floor).
      await vi.advanceTimersByTimeAsync(4000);
      await capture;
    } finally {
      vi.useRealTimers();
    }

    expect(get(captureStatus)).not.toBe("running");
    expect(get(captureBuffer)!.sampleCount).toBe(100);
    expect(get(statusMessage)).toMatch(/stopped sending samples/i);
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

    watchDeviceDisconnect();
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

    watchDeviceDisconnect();
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
    watchDeviceDisconnect();
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

  it("falls back to a re-select prompt when the device never re-enumerates", async () => {
    // Uses fake timers so the full waitForReenumeration timeout elapses without
    // a real-time wait. Mirrors a first-ever connect / incognito session: the
    // re-enumerated device's identity was never granted, so it can't be surfaced
    // automatically and the wait times out.
    vi.useFakeTimers();
    try {
      const fwBytes = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
      firmwareInfo.set({
        name: "custom.fw",
        size: fwBytes.length,
        data: fwBytes.buffer.slice(0),
      });

      const preDevice = new FakeUSBDevice({
        vendorId: 0x04b4,
        productId: 0x8613,
        manufacturerName: "Cypress",
        productName: "FX2",
      });
      handle = installFakeNavigatorUsb({
        requestDevice: preDevice,
        authorized: [],
      });

      const p = connect();
      // Drive the upload chain and let the re-enumeration wait time out.
      await vi.advanceTimersByTimeAsync(5000);
      await p;

      expect(get(connStatus)).toBe("reselect");
      expect(get(statusMessage)).toMatch(/finish connecting/i);
      // Firmware was still uploaded before we gave up on auto-reconnect.
      expect(
        preDevice.controlOut.some((c) => c.request === REQ_FIRMWARE_LOAD),
      ).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("finishConnect completes setup by re-selecting the re-enumerated device", async () => {
    connStatus.set("reselect");
    // The device chooser returns the running fx2lafw device.
    const postDevice = new FakeUSBDevice({ firmwareVersion: [1, 3], revid: 2 });
    handle = installFakeNavigatorUsb({ requestDevice: postDevice });

    await finishConnect();

    expect(get(connStatus)).toBe("ready");
    expect(get(deviceLabel)).toMatch(/fw 1\.3/);
  });

  it("finishConnect stays in reselect when the chooser is cancelled", async () => {
    connStatus.set("reselect");
    // No requestDevice configured => the fake throws "No device selected".
    handle = installFakeNavigatorUsb({});

    await finishConnect();

    expect(get(connStatus)).toBe("reselect");
    expect(get(statusMessage)).toMatch(/finish connecting/i);
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

describe("backend selection", () => {
  it("defaults to the FX2 backend", () => {
    expect(get(backendId)).toBe("fx2");
    expect(get(capabilities)).toEqual(getBackend("fx2").defaultCapabilities);
  });

  it("switches backend and publishes its default capabilities", () => {
    setBackend("sump");
    expect(get(backendId)).toBe("sump");
    // Every SUMP device dumps one buffer, so Follow and the monitor are out
    // before anything is even connected.
    expect(get(capabilities).streaming).toBe(false);
    expect(get(capabilities).continuous).toBe(false);
  });

  // The selector is disabled while connected; the guard is the second line of
  // defence, so a stale `device` can never outlive its backend.
  it("refuses to switch while a device is connected", async () => {
    const fake = new FakeUSBDevice({ firmwareVersion: [1, 3] });
    handle = installFakeNavigatorUsb({ requestDevice: fake });
    await connect();

    setBackend("sump");
    expect(get(backendId)).toBe("fx2");
  });

  // A rate or sample count the new device can't do would leave its <select>
  // showing nothing at all.
  it("clamps the config into the new backend's option lists", () => {
    config.update((c) => ({
      ...c,
      sampleRate: 24_000_000,
      sampleLimit: 100_000_000,
    }));
    setBackend("sump");
    const caps = get(capabilities);
    expect(caps.sampleRates).toContain(get(config).sampleRate);
    expect(caps.sampleLimits).toContain(get(config).sampleLimit);
  });

  it("reports Web Serial as unavailable when navigator.serial is missing", async () => {
    setBackend("sump");
    await connect();
    expect(get(connStatus)).toBe("error");
    expect(get(statusMessage)).toMatch(/web serial/i);
  });
});

describe("session capture (SUMP backend)", () => {
  /** A fake ESP32-Bit-Pirate: 4 KiSa of memory, dumping `samples`. */
  function fakeSumpPort(samples: number[]): FakeSerialPort {
    return new FakeSerialPort({
      respond: sumpResponses(
        "ESP32-BP SUMP",
        [
          [0x20, 8],
          [0x21, 4096],
          [0x23, 200_000_000],
        ],
        samples,
      ),
    });
  }

  it("connects, labels the device from its metadata, and takes its capabilities", async () => {
    const port = fakeSumpPort([]);
    serialHandle = installFakeNavigatorSerial({ requestPort: port });
    setBackend("sump");

    await connect();

    expect(get(connStatus)).toBe("ready");
    expect(get(deviceLabel)).toContain("ESP32-BP SUMP");
    // Its metadata claims 200 MHz; the 100 MHz divider clock is the real bound.
    expect(Math.max(...get(capabilities).sampleRates)).toBe(100_000_000);
    expect(get(capabilities).sampleLimits).toEqual([1024, 4096]);
    expect(connectedDevice()?.capabilities.streaming).toBe(false);
  });

  // End-to-end through startCapture: the dump arrives newest-first, and what
  // lands in the CaptureBuffer has to be in chronological order.
  it("captures a dump into the buffer in chronological order", async () => {
    const samples = Array.from({ length: 64 }, (_, i) => i & 0xff);
    serialHandle = installFakeNavigatorSerial({
      requestPort: fakeSumpPort(samples),
    });
    setBackend("sump");
    await connect();

    config.update((c) => ({ ...c, sampleRate: 1_000_000, sampleLimit: 64 }));
    await startCapture();

    const buf = get(captureBuffer)!;
    expect(buf.sampleCount).toBe(64);
    expect([...Array(64).keys()].map((i) => buf.byteAt(i))).toEqual(samples);
    expect(get(captureStatus)).toBe("done");
    expect(get(statusMessage)).toMatch(/Captured 64 samples/);
  });

  it("records the divider-resolved rate on the buffer, not the request", async () => {
    serialHandle = installFakeNavigatorSerial({
      requestPort: fakeSumpPort([1, 2, 3, 4]),
    });
    setBackend("sump");
    await connect();

    // 3 MHz is not achievable from a 100 MHz clock: 100/33 = 3,030,303.
    config.update((c) => ({ ...c, sampleRate: 3_000_000, sampleLimit: 4 }));
    await startCapture();

    expect(get(captureBuffer)!.sampleRate).toBe(3_030_303);
  });

  it("resets to disconnected when the port goes away", async () => {
    const port = fakeSumpPort([]);
    serialHandle = installFakeNavigatorSerial({ requestPort: port });
    setBackend("sump");
    watchDeviceDisconnect();
    await connect();
    expect(get(connStatus)).toBe("ready");

    serialHandle.emitDisconnect(port);

    expect(get(connStatus)).toBe("disconnected");
    expect(get(statusMessage)).toMatch(/disconnected/i);
  });
});

describe("startup with a remembered backend", () => {
  /** Load a fresh copy of session.ts with `wla.backend` already set. */
  async function bootWith(backend: string) {
    const store = new Map([["wla.backend", backend]]);
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => void store.set(k, v),
        removeItem: (k: string) => void store.delete(k),
      },
    });
    try {
      vi.resetModules();
      return await import("./session");
    } finally {
      delete (globalThis as { localStorage?: unknown }).localStorage;
    }
  }

  // The config literal is written for the FX2 defaults. Opening straight into
  // SUMP mode used to leave a 1,000,000 sample limit against options of
  // [1024, 4096], so the sample-count <select> matched nothing and rendered
  // blank — the config has to be clamped at load, not only on connect.
  it("clamps the config into the remembered backend's options at load", async () => {
    const fresh = await bootWith("sump");
    const caps = get(fresh.capabilities);
    const cfg = get(fresh.config);

    expect(get(fresh.backendId)).toBe("sump");
    expect(caps.sampleLimits).toContain(cfg.sampleLimit);
    expect(caps.sampleRates).toContain(cfg.sampleRate);
  });

  it("leaves the FX2 defaults alone", async () => {
    const fresh = await bootWith("fx2");
    const caps = get(fresh.capabilities);
    const cfg = get(fresh.config);

    expect(cfg.sampleLimit).toBe(1_000_000);
    expect(caps.sampleLimits).toContain(cfg.sampleLimit);
    expect(caps.sampleRates).toContain(cfg.sampleRate);
  });
});

describe("repeat captures", () => {
  /** fx2lafw's CMD_START — one per capture, whatever the transfer queue does. */
  const CMD_START = 0xb1;

  /**
   * Connect an FX2 whose sample data is a function of *which capture* is
   * running. Counting CMD_STARTs rather than bulk reads matters: several
   * transfers are in flight at once, so a per-read counter runs ahead of the
   * capture index and the data lands in the wrong capture.
   */
  async function connectRepeating(perCapture: (n: number) => Uint8Array) {
    const ref: { fake?: FakeUSBDevice } = {};
    const fake = new FakeUSBDevice({
      firmwareVersion: [1, 3],
      bulkChunks: () =>
        perCapture(
          (ref.fake?.controlOut ?? []).filter((c) => c.request === CMD_START)
            .length,
        ),
    });
    ref.fake = fake;
    handle = installFakeNavigatorUsb({ requestDevice: fake });
    await connect();
    return fake;
  }

  it("takes the requested number of captures and shows the last", async () => {
    await connectRepeating((n) => new Uint8Array(50).fill(n));
    config.update((c) => ({
      ...c,
      sampleRate: 1_000_000,
      sampleLimit: 50,
      captures: 3,
    }));

    await startCapture();

    expect(get(captures)).toHaveLength(3);
    expect(get(captureCursor)).toBe(3);
    expect(get(capturePosition)).toMatchObject({ index: 3, total: 3 });
    // Each capture is its own buffer, and the newest is the one displayed.
    expect(get(captureBuffer)).toBe(get(captures)[2].buffer);
    expect(get(captureStatus)).toBe("done");
    expect(get(statusMessage)).toMatch(/3 captures/);
  });

  // A single Run must behave exactly as it always has.
  it("leaves a one-capture run with no pager", async () => {
    await connectRepeating(() => new Uint8Array(50));
    config.update((c) => ({ ...c, sampleLimit: 50, captures: 1 }));

    await startCapture();

    expect(get(captures)).toHaveLength(1);
    expect(get(capturePosition)).toBeNull(); // nothing to page through
    expect(get(statusMessage)).toMatch(/Captured 50 samples/);
  });

  it("pages to another capture and re-decodes it", async () => {
    await connectRepeating((n) => new Uint8Array(50).fill(n));
    config.update((c) => ({ ...c, sampleLimit: 50, captures: 3 }));
    await startCapture();

    selectCapture(1);
    expect(get(captureCursor)).toBe(1);
    expect(get(captureBuffer)).toBe(get(captures)[0].buffer);
    expect(get(captureBuffer)!.byteAt(0)).toBe(1); // the first run's fill
    expect(get(statusMessage)).toMatch(/Capture 1 of 3/);

    stepCapture(1);
    expect(get(captureCursor)).toBe(2);
    expect(get(captureBuffer)!.byteAt(0)).toBe(2);
  });

  it("clamps the pager at both ends", async () => {
    await connectRepeating(() => new Uint8Array(50));
    config.update((c) => ({ ...c, sampleLimit: 50, captures: 2 }));
    await startCapture();

    stepCapture(-99);
    expect(get(captureCursor)).toBe(1);
    stepCapture(99);
    expect(get(captureCursor)).toBe(2);
  });

  // The point of "until stopped": keep going until the user sees the thing.
  it("repeats until stopped", async () => {
    await connectRepeating(() => new Uint8Array(50));
    config.update((c) => ({
      ...c,
      sampleLimit: 50,
      captures: CAPTURES_UNTIL_STOPPED,
    }));

    // Stop from the store itself, so the loop ends at a known count rather than
    // racing a poll — an unbounded run would otherwise take thousands of turns.
    const unsub = captures.subscribe((list) => {
      if (list.length >= 3) stopCapture();
    });
    await startCapture();
    unsub();

    expect(get(captureStatus)).toBe("done");
    // Stopping ended the loop, not merely the capture in flight.
    expect(get(captures)).toHaveLength(3);
    await new Promise((r) => setTimeout(r, 20));
    expect(get(captures)).toHaveLength(3);
  });

  // With a trigger set, the run ends on the capture that contains it — which is
  // what makes "until stopped" usable for an event you can't time by hand.
  it("stops early on the capture whose trigger matches", async () => {
    // D0 is low until the 3rd capture, which is all-high => a "high" trigger.
    await connectRepeating((n) =>
      new Uint8Array(50).fill(n >= 3 ? 0xff : 0x00),
    );
    config.update((c) => ({
      ...c,
      sampleLimit: 50,
      captures: CAPTURES_UNTIL_STOPPED,
      trigger: { conditions: [{ channel: 0, edge: "high" }] },
    }));

    await startCapture();

    expect(get(captures)).toHaveLength(3);
    expect(get(captures)[2].trigger).toBe(0);
    expect(get(triggerSample)).toBe(0);
  });

  // The other half of "multiple captures of a triggered event": a fixed count
  // means "give me this many", so a match must not cut the run short. This is
  // the norm on hardware-trigger devices, where the device waits for the
  // condition itself and so *every* capture is a triggered one.
  it("a fixed count runs to completion even though every capture triggers", async () => {
    await connectRepeating(() => new Uint8Array(50).fill(0xff));
    config.update((c) => ({
      ...c,
      sampleLimit: 50,
      captures: 3,
      trigger: { conditions: [{ channel: 0, edge: "high" }] },
    }));

    await startCapture();

    expect(get(captures)).toHaveLength(3);
    expect(get(captures).every((r) => r.trigger === 0)).toBe(true);
    expect(get(capturePosition)).toMatchObject({ triggered: 3 });
  });

  // findTrigger() reports a match at sample 0 for an empty spec, so without care
  // every capture of an untriggered run would count as "triggered".
  it("records no trigger when there was no condition to meet", async () => {
    await connectRepeating(() => new Uint8Array(50).fill(0xff));
    config.update((c) => ({
      ...c,
      sampleLimit: 50,
      captures: 2,
      trigger: { conditions: [] },
    }));

    await startCapture();

    expect(get(captures).every((r) => r.trigger === null)).toBe(true);
    expect(get(capturePosition)).toMatchObject({
      triggered: 0,
      currentTriggered: false,
    });
  });

  it("does not auto-stop when no trigger is configured", async () => {
    await connectRepeating(() => new Uint8Array(50).fill(0xff));
    config.update((c) => ({
      ...c,
      sampleLimit: 50,
      captures: 3,
      trigger: { conditions: [] },
    }));

    await startCapture();
    expect(get(captures)).toHaveLength(3);
  });

  // A Run that captured nothing has nothing to overwrite, so the next Run must
  // not ask to confirm — including the plain single-capture case.
  it("does not ask to confirm after a run that captured nothing", async () => {
    await connectRepeating(() => new Uint8Array(0));
    config.update((c) => ({ ...c, sampleLimit: 50, captures: 1 }));

    await startCapture();

    expect(get(captures)).toHaveLength(0);
    expect(get(capturedSamples)).toBe(0);
    expect(get(unsavedCapture)).toBe(false);
  });

  it("does ask once a run has captured something", async () => {
    await connectRepeating(() => new Uint8Array(50).fill(7));
    config.update((c) => ({ ...c, sampleLimit: 50, captures: 2 }));

    await startCapture();

    expect(get(capturedSamples)).toBe(100); // both captures counted
    expect(get(unsavedCapture)).toBe(true);
  });

  // The redraw is coalesced into an animation frame and reads the buffer when
  // that frame runs — not when the tick fired. Swapping the next (empty) buffer
  // in at the start of each capture therefore replaced the finished one before
  // it was ever drawn, so every capture but the last was invisible. What matters
  // is that the buffer still holds data *while the next capture is running*.
  it("leaves the finished capture on screen while the next one runs", async () => {
    const samples = [1, 2, 3, 4, 5, 6, 7, 8];
    serialHandle = installFakeNavigatorSerial({
      requestPort: quietAfter(99, samples), // answers every run
    });
    setBackend("sump");
    await connect();
    config.update((c) => ({ ...c, sampleLimit: 8, captures: 3 }));

    // Look at the buffer on a later turn, once capture 2 is under way.
    let whileNextRuns: number | null = null;
    const unsub = captures.subscribe((list) => {
      if (list.length === 1)
        setTimeout(() => {
          whileNextRuns ??= get(captureBuffer)?.sampleCount ?? -1;
        }, 0);
    });
    await startCapture();
    unsub();

    expect(whileNextRuns).toBe(8); // capture 1, not a blank successor
  });

  // findTrigger reports a match at sample 0 for an empty spec — its way of
  // saying "start at the beginning". Taken literally it draws a marker and
  // relabels the ruler "Time (from trigger)" on a capture nobody triggered.
  it("shows no trigger at all when none was configured", async () => {
    await connectRepeating(() => new Uint8Array(50).fill(0xff));
    config.update((c) => ({
      ...c,
      sampleLimit: 50,
      captures: 2,
      trigger: { conditions: [] },
    }));

    await startCapture();

    expect(get(triggerSample)).toBeNull(); // and not 0, which would draw a line
    expect(get(captures).every((r) => r.trigger === null)).toBe(true);
  });

  // The trigger is what you are watching for when you set one, and findTrigger
  // has already run for the record — so the marker belongs on each capture as it
  // lands, not only once the whole run is in.
  it("marks the trigger on each capture as it lands", async () => {
    // D0 goes high at sample 2, so the match is somewhere recognisable.
    const samples = [0, 0, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff];
    serialHandle = installFakeNavigatorSerial({
      requestPort: quietAfter(99, samples),
    });
    setBackend("sump");
    await connect();
    config.update((c) => ({
      ...c,
      sampleLimit: 8,
      captures: 3,
      trigger: { conditions: [{ channel: 0, edge: "high" }] },
    }));

    let whileNextRuns: number | null | undefined;
    const unsub = captures.subscribe((list) => {
      if (list.length === 1)
        setTimeout(() => (whileNextRuns ??= get(triggerSample)), 0);
    });
    await startCapture();
    unsub();

    expect(whileNextRuns).toBe(2); // capture 1's trigger, mid-run
  });

  // The landed capture is on screen, so empty decoder lanes under a drawn
  // waveform look half-rendered — and with "until stopped" the decoded bytes are
  // how you decide to stop. Small enough captures are decoded as they land.
  it("decodes each capture as it lands, not only at the end", async () => {
    const spb = 10;
    const frame = uartBytes([0x41], spb, 1_000_000); // one 'A'
    const bytes = new Uint8Array(frame.sampleCount);
    for (let i = 0; i < frame.sampleCount; i++) bytes[i] = frame.byteAt(i);

    await connectRepeating(() => bytes);
    decoders.set([
      {
        uid: "d1",
        decoderId: "uart",
        label: "UART 1",
        channelMap: [0],
        options: { baudrate: 1_000_000 / spb },
        annotations: [],
      },
    ]);
    config.update((c) => ({
      ...c,
      sampleRate: 1_000_000,
      sampleLimit: bytes.length,
      captures: 3,
    }));

    // Read synchronously as the first capture is recorded: the decode happens
    // just before `captures.set`, and the run is over before any timer fires.
    let midRun: number | undefined;
    const unsub = captures.subscribe((list) => {
      if (list.length === 1) midRun ??= get(decoders)[0]?.annotations.length;
    });
    await startCapture();
    unsub();

    expect(midRun).toBeGreaterThan(0); // lanes populated, not left for the end
  });

  // Unplugging part-way through must keep the captures already taken, and let
  // the disconnect message stand rather than a cheery "Captured N".
  it("keeps completed captures when the device is unplugged mid-run", async () => {
    const fake = await connectRepeating(() => new Uint8Array(50).fill(1));
    watchDeviceDisconnect();
    config.update((c) => ({ ...c, sampleLimit: 50, captures: 10 }));

    const run = startCapture();
    const unsub = captures.subscribe((list) => {
      if (list.length === 2) handle?.emitDisconnect(fake);
    });
    await run;
    unsub();

    expect(get(connStatus)).toBe("disconnected");
    expect(get(captures).length).toBeGreaterThanOrEqual(2);
    expect(get(captures).length).toBeLessThan(10); // stopped early, not all 10
    expect(get(captureStatus)).toBe("done");
    expect(get(statusMessage)).toMatch(/disconnect/i);
  });

  // Two runs would drive the same device at once and leave Stop reaching only
  // one of them — the module-level `session` and `repeatStopped` are shared.
  it("ignores a second Run started while one is in flight", async () => {
    const fake = await connectRepeating(() => new Uint8Array(50));
    config.update((c) => ({ ...c, sampleLimit: 50, captures: 3 }));

    const first = startCapture();
    const second = startCapture();
    await Promise.all([first, second]);

    expect(get(captures)).toHaveLength(3);
    // One CMD_START per capture, not two loops' worth.
    expect(fake.controlOut.filter((c) => c.request === CMD_START)).toHaveLength(
      3,
    );
  });

  it("an imported capture clears the pager", async () => {
    await connectRepeating(() => new Uint8Array(50));
    config.update((c) => ({ ...c, sampleLimit: 50, captures: 3 }));
    await startCapture();
    expect(get(captures)).toHaveLength(3);

    const imported = new CaptureBuffer(1_000_000, 8);
    imported.append(new Uint8Array([1, 2, 3]));
    loadCapture(imported);

    expect(get(captures)).toHaveLength(0);
    expect(get(capturePosition)).toBeNull();
  });
});

describe("trimRetained", () => {
  const rec = (samples: number): CaptureRecord => ({
    buffer: { sampleCount: samples } as CaptureRecord["buffer"],
    atMs: 0,
    trigger: null,
  });

  it("keeps everything inside both budgets", () => {
    const list = [rec(10), rec(10), rec(10)];
    expect(trimRetained(list, 100, 10)).toBe(list); // same array, no copy
  });

  it("drops the oldest until the sample budget fits", () => {
    const list = [rec(50), rec(50), rec(50)];
    expect(trimRetained(list, 120, 10)).toEqual([list[1], list[2]]);
  });

  // The sample budget alone can't bound a long run of tiny captures, and the
  // list is copied every capture — so the count cap is what keeps it linear.
  it("drops the oldest once there are too many, however small", () => {
    const list = Array.from({ length: 8 }, () => rec(1));
    const kept = trimRetained(list, 1_000_000, 5);
    expect(kept).toHaveLength(5);
    expect(kept[4]).toBe(list[7]); // the newest survives
  });

  it("never drops the only capture, even if it busts the budget", () => {
    const list = [rec(999)];
    expect(trimRetained(list, 10, 10)).toHaveLength(1);
  });
});

describe("stopping a repeat run", () => {
  // Stopping while a device is mid-capture is routine — it owes us nothing until
  // its memory is full. The aborted capture holds no samples, and recording it
  // would leave the pager on a blank capture with the real ones behind it.
  it("does not keep the empty capture it was stopped during", async () => {
    const samples = [1, 2, 3, 4, 5, 6, 7, 8];
    serialHandle = installFakeNavigatorSerial({
      requestPort: quietAfter(2, samples),
    });
    setBackend("sump");
    await connect();
    config.update((c) => ({
      ...c,
      sampleRate: 1_000_000,
      sampleLimit: 8,
      captures: CAPTURES_UNTIL_STOPPED,
    }));

    // Start first: startCapture() clears `captures` synchronously, so a
    // subscription taken before it would fire with the previous test's value.
    // Stop on a later turn, so the third capture has begun and is parked waiting
    // for a device that will never answer.
    const run = startCapture();
    const unsub = captures.subscribe((list) => {
      if (list.length === 2) setTimeout(() => stopCapture(), 0);
    });
    await run;
    unsub();

    expect(get(captures)).toHaveLength(2);
    expect(get(captures).every((r) => r.buffer.sampleCount === 8)).toBe(true);
    // The view lands on the newest capture that actually holds something.
    expect(get(captureBuffer)).toBe(get(captures)[1].buffer);
    expect(get(captureBuffer)!.sampleCount).toBe(8);
    expect(get(captureStatus)).toBe("done");
  });

  // The Run button and the unload guard both used to read only the displayed
  // buffer, so an empty final capture made a run full of samples look like
  // nothing worth keeping — Run overwrote it without asking.
  it("still counts the earlier captures as unsaved work", async () => {
    const samples = [1, 2, 3, 4, 5, 6, 7, 8];
    serialHandle = installFakeNavigatorSerial({
      requestPort: quietAfter(2, samples),
    });
    setBackend("sump");
    await connect();
    config.update((c) => ({
      ...c,
      sampleLimit: 8,
      captures: CAPTURES_UNTIL_STOPPED,
    }));

    const run = startCapture();
    const unsub = captures.subscribe((list) => {
      if (list.length === 2) setTimeout(() => stopCapture(), 0);
    });
    await run;
    unsub();

    expect(get(capturedSamples)).toBe(16); // both captures, not just the shown one
    expect(get(unsavedCapture)).toBe(true);
  });
});
