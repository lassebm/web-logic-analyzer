// Small formatting helpers shared by the protocol decoders (and the serial
// monitor's char rendering). Keeps hex/printable conventions identical across
// decoders instead of re-derived per file.

/** True for printable 7-bit ASCII (0x20..0x7E). */
export function isPrintable(byte: number): boolean {
  return byte >= 0x20 && byte < 0x7f;
}

/**
 * Uppercase hex with a `0x` prefix, zero-padded to `digits` (default 2).
 * Pass `digits: 0` for no padding (e.g. a variable-width bus ID).
 */
export function hex(value: number, digits = 2): string {
  return "0x" + value.toString(16).toUpperCase().padStart(digits, "0");
}
