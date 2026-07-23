import { afterEach, describe, expect, it } from "vitest";
import { FakeUSBDevice, installFakeNavigatorUsb } from "../test/fakeUsb";
import type { FakeNavigatorUsbHandle } from "../test/fakeUsb";
import { Fx2Device } from "./fx2Device";

let handle: FakeNavigatorUsbHandle | undefined;

afterEach(() => {
  handle?.restore();
  handle = undefined;
});

describe("Fx2Device.isSupported", () => {
  it("is false when navigator.usb is absent", () => {
    // No fake installed: the default Node navigator has no `usb`.
    expect(Fx2Device.isSupported()).toBe(false);
  });

  it("is true once navigator.usb is present", () => {
    handle = installFakeNavigatorUsb({});
    expect(Fx2Device.isSupported()).toBe(true);
  });
});

describe("Fx2Device.request / getAuthorized", () => {
  it("request() wraps the device returned by navigator.usb.requestDevice", async () => {
    const fake = new FakeUSBDevice({ vendorId: 0x1d50, productId: 0x608c });
    handle = installFakeNavigatorUsb({ requestDevice: fake });

    const dev = await Fx2Device.request();
    expect(dev).toBeInstanceOf(Fx2Device);
    expect(dev.device).toBe(fake as unknown as USBDevice);
  });

  it("request() throws when WebUSB is unavailable", async () => {
    // No fake installed.
    await expect(Fx2Device.request()).rejects.toThrow(
      /WebUSB is not available/,
    );
  });

  it("getAuthorized() wraps each device from navigator.usb.getDevices", async () => {
    const a = new FakeUSBDevice({ productId: 0x608c });
    const b = new FakeUSBDevice({ productId: 0x608d });
    handle = installFakeNavigatorUsb({ authorized: [a, b] });

    const devices = await Fx2Device.getAuthorized();
    expect(devices).toHaveLength(2);
    expect(devices[0].device).toBe(a as unknown as USBDevice);
    expect(devices[1].device).toBe(b as unknown as USBDevice);
  });

  it("getAuthorized() returns [] when WebUSB is unavailable", async () => {
    await expect(Fx2Device.getAuthorized()).resolves.toEqual([]);
  });
});

describe("Fx2Device getters", () => {
  it("surface the underlying device fields", () => {
    const fake = new FakeUSBDevice({
      vendorId: 0x04b4,
      productId: 0x8613,
      manufacturerName: "Cypress",
      productName: "FX2",
    });
    const dev = new Fx2Device(fake as unknown as USBDevice);

    expect(dev.vendorId).toBe(0x04b4);
    expect(dev.productId).toBe(0x8613);
    expect(dev.manufacturerName).toBe("Cypress");
    expect(dev.productName).toBe("FX2");
    expect(dev.opened).toBe(false);
  });

  it("maps null string descriptors to undefined", () => {
    // The shared fake coalesces null options to its defaults, so drive this
    // mapping with a one-off stub whose descriptors are genuinely null.
    const stub = {
      vendorId: 0,
      productId: 0,
      manufacturerName: null,
      productName: null,
      opened: false,
    };
    const dev = new Fx2Device(stub as unknown as USBDevice);
    expect(dev.manufacturerName).toBeUndefined();
    expect(dev.productName).toBeUndefined();
  });
});

describe("Fx2Device.open", () => {
  it("opens the device and selects a configuration when none is set", async () => {
    const fake = new FakeUSBDevice();
    const dev = new Fx2Device(fake as unknown as USBDevice);

    expect(fake.configuration).toBeNull();
    await dev.open();

    expect(fake.openCalls).toBe(1);
    expect(fake.selectConfigCalls).toBe(1);
    expect(fake.opened).toBe(true);
    expect(dev.opened).toBe(true);
  });

  it("does not re-open an already-open device", async () => {
    const fake = new FakeUSBDevice();
    const dev = new Fx2Device(fake as unknown as USBDevice);

    await dev.open();
    await dev.open();
    // Second call sees opened === true and a configuration already applied.
    expect(fake.openCalls).toBe(1);
    expect(fake.selectConfigCalls).toBe(1);
  });
});

describe("Fx2Device.claim", () => {
  it("resolves the bulk-IN endpoint to 0x82 by default and claims interface 0", async () => {
    const fake = new FakeUSBDevice({ bulkInEndpointNumber: 2 });
    const dev = new Fx2Device(fake as unknown as USBDevice);

    await dev.claim();

    expect(dev.bulkIn).toBe(0x82);
    expect(fake.claimedInterfaces).toEqual([0]);
  });

  it("resolves the bulk-IN endpoint to 0x86 for older firmware", async () => {
    const fake = new FakeUSBDevice({ bulkInEndpointNumber: 6 });
    const dev = new Fx2Device(fake as unknown as USBDevice);

    await dev.claim();

    expect(dev.bulkIn).toBe(0x86);
    expect(fake.claimedInterfaces).toEqual([0]);
  });

  it("claims the interface only once across repeated calls", async () => {
    const fake = new FakeUSBDevice();
    const dev = new Fx2Device(fake as unknown as USBDevice);

    await dev.claim();
    await dev.claim();
    expect(fake.claimedInterfaces).toEqual([0]);
  });

  it("throws when the device exposes no USB interface", async () => {
    const stub = {
      opened: true,
      configuration: { interfaces: [] },
      async open() {},
      async claimInterface() {},
    };
    const dev = new Fx2Device(stub as unknown as USBDevice);
    await expect(dev.claim()).rejects.toThrow(/no USB interface/i);
  });
});

describe("Fx2Device.controlOut / controlIn", () => {
  it("records a control-OUT transfer", async () => {
    const fake = new FakeUSBDevice();
    const dev = new Fx2Device(fake as unknown as USBDevice);

    await dev.controlOut(0xa0, 0xe600, new Uint8Array([0x01]));

    expect(fake.controlOut).toHaveLength(1);
    expect(fake.controlOut[0]).toMatchObject({
      request: 0xa0,
      value: 0xe600,
      index: 0,
    });
    expect(Array.from(fake.controlOut[0].data)).toEqual([0x01]);
  });

  it("returns the DataView from a control-IN transfer", async () => {
    const fake = new FakeUSBDevice({ firmwareVersion: [1, 3] });
    const dev = new Fx2Device(fake as unknown as USBDevice);

    const data = await dev.controlIn(0xb0, 0, 2);
    expect(data.getUint8(0)).toBe(1);
    expect(data.getUint8(1)).toBe(3);
  });

  it("controlOut throws when the transfer status is not ok", async () => {
    const stub = {
      async controlTransferOut() {
        return { status: "stall", bytesWritten: 0 } as USBOutTransferResult;
      },
    };
    const dev = new Fx2Device(stub as unknown as USBDevice);
    await expect(
      dev.controlOut(0xa0, 0x0000, new Uint8Array([1])),
    ).rejects.toThrow(/status=stall/);
  });

  it("controlIn throws when the transfer status is not ok", async () => {
    const stub = {
      async controlTransferIn() {
        return { status: "babble" } as unknown as USBInTransferResult;
      },
    };
    const dev = new Fx2Device(stub as unknown as USBDevice);
    await expect(dev.controlIn(0xb0, 0, 2)).rejects.toThrow(/status=babble/);
  });
});

describe("Fx2Device.reset / release / close", () => {
  it("reset() resets the device", async () => {
    const fake = new FakeUSBDevice();
    const dev = new Fx2Device(fake as unknown as USBDevice);
    await dev.reset();
    expect(fake.resetCalls).toBe(1);
  });

  it("release() releases the claimed interface while open", async () => {
    const fake = new FakeUSBDevice();
    const dev = new Fx2Device(fake as unknown as USBDevice);
    await dev.claim();
    await dev.release();
    expect(fake.releasedInterfaces).toEqual([0]);
  });

  it("close() closes an open device", async () => {
    const fake = new FakeUSBDevice();
    const dev = new Fx2Device(fake as unknown as USBDevice);
    await dev.open();
    await dev.close();
    expect(fake.closeCalls).toBe(1);
    expect(fake.opened).toBe(false);
  });

  it("reset / release / close swallow underlying errors", async () => {
    const stub = {
      opened: true,
      async reset() {
        throw new Error("reset failed");
      },
      async releaseInterface() {
        throw new Error("release failed");
      },
      async close() {
        throw new Error("close failed");
      },
    };
    const dev = new Fx2Device(stub as unknown as USBDevice);
    await expect(dev.reset()).resolves.toBeUndefined();
    await expect(dev.release()).resolves.toBeUndefined();
    await expect(dev.close()).resolves.toBeUndefined();
  });
});
