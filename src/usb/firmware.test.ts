// Tests for the firmware detect/upload/re-enumerate helpers in firmware.ts,
// driven through the shared WebUSB fake (src/test/fakeUsb) wrapped in a real
// Fx2Device — so the device seam is exercised end to end, not stubbed away.
import { afterEach, describe, expect, it } from "vitest";
import { FakeUSBDevice, installFakeNavigatorUsb } from "../test/fakeUsb";
import type { FakeNavigatorUsbHandle } from "../test/fakeUsb";
import { CPUCS_ADDR, FW_CHUNK_SIZE, REQ_FIRMWARE_LOAD } from "./constants";
import { Fx2Device } from "./fx2Device";
import {
  needsFirmware,
  uploadFirmware,
  waitForReenumeration,
} from "./firmware";

let handle: FakeNavigatorUsbHandle | undefined;

afterEach(() => {
  handle?.restore();
  handle = undefined;
});

function wrap(opts?: ConstructorParameters<typeof FakeUSBDevice>[0]) {
  const fake = new FakeUSBDevice(opts);
  return { fake, dev: new Fx2Device(fake as unknown as USBDevice) };
}

describe("needsFirmware", () => {
  it("is false for a running sigrok/fx2lafw device", () => {
    const { dev } = wrap({
      manufacturerName: "sigrok",
      productName: "fx2lafw",
    });
    expect(needsFirmware(dev)).toBe(false);
  });

  it("is true for a stock/other identity", () => {
    const { dev } = wrap({ manufacturerName: "Cypress", productName: "FX2" });
    expect(needsFirmware(dev)).toBe(true);
  });

  it("is case-insensitive on the descriptor strings", () => {
    const { dev } = wrap({
      manufacturerName: "SigRok",
      productName: "FX2LAFW",
    });
    expect(needsFirmware(dev)).toBe(false);
  });

  it("treats missing descriptors as needing firmware", () => {
    const { dev } = wrap({ manufacturerName: null, productName: null });
    expect(needsFirmware(dev)).toBe(true);
  });
});

describe("uploadFirmware", () => {
  it("brackets the chunked upload with CPU reset hold/release", async () => {
    const { fake, dev } = wrap();
    const total = 5000; // > FW_CHUNK_SIZE (4096) => two chunks
    const image = new Uint8Array(total);
    for (let i = 0; i < total; i++) image[i] = i & 0xff;

    const progress: number[] = [];
    await uploadFirmware(dev, image.buffer, (done, tot) => {
      expect(tot).toBe(total);
      progress.push(done);
    });

    const writes = fake.controlOut;
    // hold + (two chunks) + release
    expect(writes.length).toBe(4);

    // First write: hold CPU in reset (data byte 0x01 at CPUCS_ADDR).
    expect(writes[0]).toMatchObject({
      request: REQ_FIRMWARE_LOAD,
      value: CPUCS_ADDR,
    });
    expect(Array.from(writes[0].data)).toEqual([0x01]);

    // Last write: release CPU from reset (data byte 0x00 at CPUCS_ADDR).
    const last = writes[writes.length - 1];
    expect(last).toMatchObject({
      request: REQ_FIRMWARE_LOAD,
      value: CPUCS_ADDR,
    });
    expect(Array.from(last.data)).toEqual([0x00]);

    // Middle writes are the firmware chunks at ascending RAM offsets, each
    // carrying exactly its slice of the image.
    const chunks = writes.slice(1, -1);
    expect(chunks.map((w) => w.value)).toEqual([0, FW_CHUNK_SIZE]);
    expect(chunks[0].data.length).toBe(FW_CHUNK_SIZE);
    expect(chunks[1].data.length).toBe(total - FW_CHUNK_SIZE);
    expect(Array.from(chunks[0].data)).toEqual(
      Array.from(image.subarray(0, FW_CHUNK_SIZE)),
    );
    expect(Array.from(chunks[1].data)).toEqual(
      Array.from(image.subarray(FW_CHUNK_SIZE)),
    );
    for (const w of chunks) expect(w.request).toBe(REQ_FIRMWARE_LOAD);

    // Progress is monotonically non-decreasing and ends at the total.
    expect(progress).toEqual([FW_CHUNK_SIZE, total]);
    expect(fake.openCalls).toBe(1);
  });

  it("handles an image smaller than one chunk", async () => {
    const { fake, dev } = wrap();
    await uploadFirmware(dev, new Uint8Array(10).buffer);
    // hold + one chunk + release
    expect(fake.controlOut.length).toBe(3);
    expect(fake.controlOut[1].value).toBe(0);
    expect(fake.controlOut[1].data.length).toBe(10);
  });
});

describe("waitForReenumeration", () => {
  it("resolves the device once a post-firmware device becomes authorized", async () => {
    handle = installFakeNavigatorUsb({ authorized: [] });

    const pending = waitForReenumeration(5000);

    // Simulate re-enumeration: a running fx2lafw device appears.
    const post = new FakeUSBDevice({
      manufacturerName: "sigrok",
      productName: "fx2lafw",
    });
    handle.authorized.push(post);
    handle.emitConnect();

    const resolved = await pending;
    expect(resolved).not.toBeNull();
    expect(resolved!.device).toBe(post as unknown as USBDevice);
  });

  it("resolves null on timeout when nothing appears", async () => {
    handle = installFakeNavigatorUsb({ authorized: [] });
    await expect(waitForReenumeration(50)).resolves.toBeNull();
  });
});
