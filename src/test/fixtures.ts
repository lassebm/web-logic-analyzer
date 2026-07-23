// Shared non-waveform test fixtures.
import { NUM_CHANNELS } from "../usb/constants";
import type { CaptureConfigState } from "../stores/session";

/** A fresh default capture config (all channels on, no trigger). */
export function defaultConfig(
  overrides: Partial<CaptureConfigState> = {},
): CaptureConfigState {
  return {
    sampleRate: 1_000_000,
    sampleLimit: 1_000_000,
    enabledChannels: Array(NUM_CHANNELS).fill(true),
    trigger: { conditions: [] },
    ...overrides,
  };
}
