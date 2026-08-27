import { describe, expect, it } from "vitest";
import { parseMetadata } from "./metadata";

/** Key byte plus a big-endian u32 — the type-1 record form. */
function u32(key: number, value: number): number[] {
  return [
    key,
    (value >>> 24) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 8) & 0xff,
    value & 0xff,
  ];
}

function str(key: number, text: string): number[] {
  return [key, ...[...text].map((c) => c.charCodeAt(0)), 0x00];
}

describe("parseMetadata", () => {
  it("reads a full ESP32-Bit-Pirate response", () => {
    const bytes = new Uint8Array([
      ...str(0x01, "ESP32-BP SUMP"),
      ...str(0x02, "Polling MVP"),
      ...u32(0x20, 8), // probes
      ...u32(0x21, 65_536), // sample memory
      ...u32(0x23, 200_000_000), // max sample rate
      ...u32(0x24, 2), // protocol version
      0x00,
    ]);
    const { meta, complete } = parseMetadata(bytes);
    expect(complete).toBe(true);
    expect(meta).toEqual({
      name: "ESP32-BP SUMP",
      fpgaVersion: "Polling MVP",
      probes: 8,
      sampleMemory: 65_536,
      maxSampleRate: 200_000_000,
      protocolVersion: 2,
    });
  });

  // Metadata integers are big-endian while every command payload is
  // little-endian; getting this backwards is the classic SUMP bug.
  it("reads u32 records big-endian, not little-endian", () => {
    const { meta } = parseMetadata(
      new Uint8Array([...u32(0x23, 100_000_000), 0x00]),
    );
    expect(meta.maxSampleRate).toBe(100_000_000);
  });

  it("handles a real Open Logic Sniffer response", () => {
    const bytes = new Uint8Array([
      ...str(0x01, "Open Logic Sniffer v1.01"),
      ...str(0x02, "3.07"),
      ...u32(0x20, 32),
      ...u32(0x21, 24_576),
      ...u32(0x23, 200_000_000),
      ...u32(0x24, 2),
      0x00,
    ]);
    const { meta } = parseMetadata(bytes);
    expect(meta.name).toBe("Open Logic Sniffer v1.01");
    expect(meta.probes).toBe(32);
    expect(meta.sampleMemory).toBe(24_576);
  });

  it("accepts the short (single-byte) probe and version keys", () => {
    const { meta, complete } = parseMetadata(
      new Uint8Array([0x40, 24, 0x41, 1, 0x00]),
    );
    expect(complete).toBe(true);
    expect(meta.probes).toBe(24);
    expect(meta.protocolVersion).toBe(1);
  });

  // A JTAGulator-shaped response: a name, then short-form keys.
  it("parses a JTAGulator byte sequence", () => {
    const bytes = new Uint8Array([
      ...str(0x01, "JTAGulator"),
      ...u32(0x20, 24),
      ...u32(0x21, 1024),
      ...u32(0x23, 1_200_000),
      0x41,
      2,
      0x00,
    ]);
    const { meta, complete } = parseMetadata(bytes);
    expect(complete).toBe(true);
    expect(meta).toEqual({
      name: "JTAGulator",
      probes: 24,
      sampleMemory: 1024,
      maxSampleRate: 1_200_000,
      protocolVersion: 2,
    });
  });

  // An unknown key still has a *known length* for types 0-2, so the parse can
  // step over it and keep the records that follow.
  it("skips unknown keys of type 0, 1 and 2 by their own length", () => {
    const bytes = new Uint8Array([
      ...str(0x03, "ancillary"), // type 0, known
      ...str(0x1f, "unknown string"), // type 0, unknown
      ...u32(0x2f, 12345), // type 1, unknown
      0x5f,
      7, // type 2, unknown
      ...u32(0x20, 8), // still parsed
      0x00,
    ]);
    const { meta, complete } = parseMetadata(bytes);
    expect(complete).toBe(true);
    expect(meta.ancillaryVersion).toBe("ancillary");
    expect(meta.probes).toBe(8);
  });

  // Type >= 3 has no defined length, so there is no way to skip it — keep what
  // came before rather than reading the rest as garbage.
  it("stops at a type-3-or-higher key and keeps what came before", () => {
    const bytes = new Uint8Array([
      ...str(0x01, "Weird"),
      0x60, // type 3
      0xff,
      0xff,
      ...u32(0x20, 8), // must NOT be picked up
      0x00,
    ]);
    const { meta, complete } = parseMetadata(bytes);
    expect(complete).toBe(false);
    expect(meta.name).toBe("Weird");
    expect(meta.probes).toBeUndefined();
  });

  it("reports an unterminated response as incomplete", () => {
    const { meta, complete } = parseMetadata(
      new Uint8Array([...str(0x01, "Half"), ...u32(0x20, 8)]),
    );
    expect(complete).toBe(false);
    expect(meta.probes).toBe(8);
  });

  it("treats a truncated string or u32 as not-yet-complete", () => {
    expect(parseMetadata(new Uint8Array([0x01, 0x41, 0x42])).complete).toBe(
      false,
    );
    expect(parseMetadata(new Uint8Array([0x20, 0x00, 0x01])).meta.probes).toBe(
      undefined,
    );
  });

  it("is empty for an empty response", () => {
    const { meta, complete } = parseMetadata(new Uint8Array(0));
    expect(meta).toEqual({});
    expect(complete).toBe(false);
  });

  it("completes immediately on a bare terminator", () => {
    expect(parseMetadata(new Uint8Array([0x00]))).toEqual({
      meta: {},
      complete: true,
    });
  });
});
