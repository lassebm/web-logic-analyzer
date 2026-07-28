// Shared non-waveform test fixtures.
import { NUM_CHANNELS } from "../usb/constants";
import type { CaptureConfigState } from "../stores/session";
import type { MonitorLine } from "../monitor/terminal";

let nextLineId = 0;

/** A serial-monitor line whose bytes match `text`, with ids unique per call. */
export function monitorLine(
  text: string,
  overrides: Partial<MonitorLine> = {},
): MonitorLine {
  return {
    id: nextLineId++,
    t: 0,
    dt: 0,
    text,
    bytes: [...text].map((c) => c.charCodeAt(0)),
    lastT: 0,
    continued: false,
    ...overrides,
  };
}

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
