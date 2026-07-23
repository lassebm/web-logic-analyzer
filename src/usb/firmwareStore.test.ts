import "fake-indexeddb/auto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  saveFirmware,
  loadFirmware,
  clearFirmware,
  MAX_FIRMWARE_BYTES,
} from "./firmwareStore";

function fakeFile(name: string, bytes: Uint8Array): File {
  return {
    name,
    size: bytes.byteLength,
    arrayBuffer: async () => bytes.buffer,
  } as unknown as File;
}

/** A file whose reported size is decoupled from its (unread) contents, so the
 *  size guard can be exercised without allocating hundreds of KB. */
function fakeFileSized(name: string, size: number): File {
  return {
    name,
    size,
    arrayBuffer: async () => new Uint8Array(0).buffer,
  } as unknown as File;
}

afterEach(async () => {
  await clearFirmware();
});

describe("firmwareStore", () => {
  it("returns null when nothing is stored", async () => {
    expect(await loadFirmware()).toBeNull();
  });

  it("round-trips name, size, and data bytes", async () => {
    const bytes = new Uint8Array([0xc0, 0xff, 0xee, 0x01, 0x02, 0x03]);
    const saved = await saveFirmware(fakeFile("custom.fw", bytes));

    expect(saved.name).toBe("custom.fw");
    expect(saved.size).toBe(bytes.byteLength);

    const record = await loadFirmware();
    expect(record).not.toBeNull();
    expect(record!.name).toBe("custom.fw");
    expect(record!.size).toBe(bytes.byteLength);
    expect(new Uint8Array(record!.data)).toEqual(bytes);
  });

  it("overwrites the single current slot on re-save", async () => {
    const a = new Uint8Array([0x11, 0x22, 0x33]);
    const b = new Uint8Array([0xaa, 0xbb, 0xcc, 0xdd]);

    await saveFirmware(fakeFile("a.fw", a));
    await saveFirmware(fakeFile("b.fw", b));

    const record = await loadFirmware();
    expect(record).not.toBeNull();
    expect(record!.name).toBe("b.fw");
    expect(record!.size).toBe(b.byteLength);
    expect(new Uint8Array(record!.data)).toEqual(b);
  });

  it("clearFirmware removes the stored firmware", async () => {
    await saveFirmware(fakeFile("gone.fw", new Uint8Array([0x42])));
    expect(await loadFirmware()).not.toBeNull();

    await clearFirmware();
    expect(await loadFirmware()).toBeNull();
  });

  it("loadFirmware swallows IndexedDB failures and returns null", async () => {
    // Force the DB open to blow up so the read genuinely throws; loadFirmware's
    // try/catch must absorb it and resolve to null rather than reject.
    const open = vi.spyOn(indexedDB, "open").mockImplementation(() => {
      throw new Error("IndexedDB unavailable");
    });
    try {
      expect(await loadFirmware()).toBeNull();
    } finally {
      open.mockRestore();
    }
  });

  it("rejects an empty firmware file", async () => {
    await expect(saveFirmware(fakeFileSized("empty.fw", 0))).rejects.toThrow(
      /empty/i,
    );
    expect(await loadFirmware()).toBeNull();
  });

  it("rejects an oversized firmware file before reading it", async () => {
    await expect(
      saveFirmware(fakeFileSized("huge.fw", MAX_FIRMWARE_BYTES + 1)),
    ).rejects.toThrow(/limit/i);
    expect(await loadFirmware()).toBeNull();
  });
});
