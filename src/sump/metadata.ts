// Parser for the SUMP `0x04` metadata response — a TLV stream, terminated by a
// 0x00 key. Note the byte order: metadata integers are BIG-endian, while every
// command payload is little-endian.
//
// The key's top three bits give the value type:
//   0 -> NUL-terminated string, 1 -> u32 (big-endian), 2 -> u8, >= 3 -> undefined
// An unknown key of type 0–2 can be skipped by its own length; type >= 3 has no
// defined length, so the parse has to stop there rather than guess.

const KEY_END = 0x00;
const KEY_DEVICE_NAME = 0x01;
const KEY_FPGA_VERSION = 0x02;
const KEY_ANCILLARY_VERSION = 0x03;
const KEY_NUM_PROBES_LONG = 0x20;
const KEY_SAMPLE_MEMORY_BYTES = 0x21;
const KEY_DYNAMIC_MEMORY_BYTES = 0x22;
const KEY_MAX_SAMPLE_RATE_HZ = 0x23;
const KEY_PROTOCOL_VERSION_LONG = 0x24;
const KEY_NUM_PROBES_SHORT = 0x40;
const KEY_PROTOCOL_VERSION_SHORT = 0x41;

export interface SumpMetadata {
  name?: string;
  fpgaVersion?: string;
  ancillaryVersion?: string;
  probes?: number;
  sampleMemory?: number;
  dynamicMemory?: number;
  maxSampleRate?: number;
  protocolVersion?: number;
}

interface MetadataParse {
  meta: SumpMetadata;
  /** True once the 0x00 terminator was reached — the caller can stop reading. */
  complete: boolean;
}

/**
 * Parse as much of `bytes` as is complete. Truncated input yields
 * `complete: false` and whatever whole records were present, so a caller can
 * feed a growing buffer and stop when this says it's done.
 */
export function parseMetadata(bytes: Uint8Array): MetadataParse {
  const meta: SumpMetadata = {};
  let i = 0;

  while (i < bytes.length) {
    const key = bytes[i];
    if (key === KEY_END) return { meta, complete: true };
    const type = key >> 5;
    i++;

    if (type === 0) {
      // NUL-terminated string.
      let end = i;
      while (end < bytes.length && bytes[end] !== 0) end++;
      if (end >= bytes.length) break; // no terminator yet
      const text = new TextDecoder().decode(bytes.subarray(i, end));
      i = end + 1;
      if (key === KEY_DEVICE_NAME) meta.name = text;
      else if (key === KEY_FPGA_VERSION) meta.fpgaVersion = text;
      else if (key === KEY_ANCILLARY_VERSION) meta.ancillaryVersion = text;
      continue;
    }

    if (type === 1) {
      if (i + 4 > bytes.length) break;
      const v =
        ((bytes[i] << 24) |
          (bytes[i + 1] << 16) |
          (bytes[i + 2] << 8) |
          bytes[i + 3]) >>>
        0;
      i += 4;
      if (key === KEY_NUM_PROBES_LONG) meta.probes = v;
      else if (key === KEY_SAMPLE_MEMORY_BYTES) meta.sampleMemory = v;
      else if (key === KEY_DYNAMIC_MEMORY_BYTES) meta.dynamicMemory = v;
      else if (key === KEY_MAX_SAMPLE_RATE_HZ) meta.maxSampleRate = v;
      else if (key === KEY_PROTOCOL_VERSION_LONG) meta.protocolVersion = v;
      continue;
    }

    if (type === 2) {
      if (i + 1 > bytes.length) break;
      const v = bytes[i];
      i += 1;
      if (key === KEY_NUM_PROBES_SHORT) meta.probes = v;
      else if (key === KEY_PROTOCOL_VERSION_SHORT) meta.protocolVersion = v;
      continue;
    }

    // Type >= 3 has no defined length: we cannot skip it, so stop and keep what
    // we have rather than reading the rest as garbage.
    break;
  }

  return { meta, complete: false };
}
