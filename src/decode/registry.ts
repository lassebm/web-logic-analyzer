import type { Decoder } from "./types";
import { uartDecoder } from "./decoders/uart";
import { spiDecoder } from "./decoders/spi";
import { i2cDecoder } from "./decoders/i2c";
import { onewireDecoder } from "./decoders/onewire";
import { canDecoder } from "./decoders/can";
import { asciiDecoder } from "./decoders/ascii";

/** All available decoders, keyed by meta.id. Add new decoders here. */
export const DECODERS: Decoder[] = [
  uartDecoder,
  spiDecoder,
  i2cDecoder,
  onewireDecoder,
  canDecoder,
  asciiDecoder,
];

export function getDecoder(id: string): Decoder | undefined {
  return DECODERS.find((d) => d.meta.id === id);
}
