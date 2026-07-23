import {
  CLK_30MHZ,
  CLK_48MHZ,
  CMD_START_FLAGS_CLK_30MHZ,
  CMD_START_FLAGS_CLK_48MHZ,
  CMD_START_FLAGS_SAMPLE_16BIT,
  CMD_START_FLAGS_SAMPLE_8BIT,
  MAX_SAMPLE_DELAY,
} from "./constants";

/**
 * Supported sample rates (Hz), matching libsigrok's fx2lafw samplerate table.
 * 48 MHz is possible but USB-bandwidth-marginal, so it is left out of the
 * default list; the encoder still handles it if requested.
 */
export const SAMPLE_RATES: number[] = [
  20_000, 25_000, 50_000, 100_000, 200_000, 250_000, 500_000, 1_000_000,
  2_000_000, 3_000_000, 4_000_000, 6_000_000, 8_000_000, 12_000_000, 16_000_000,
  24_000_000,
];

export interface StartConfig {
  /** flags byte of cmd_start_acquisition */
  flags: number;
  /** high byte of the 16-bit sample-delay divisor */
  sampleDelayH: number;
  /** low byte of the 16-bit sample-delay divisor */
  sampleDelayL: number;
  /** resolved base clock actually used (for diagnostics) */
  baseClock: number;
  /** resolved divisor delay (for diagnostics/tests) */
  delay: number;
}

/**
 * Encode a sample rate into the fx2lafw cmd_start_acquisition fields.
 *
 * The FX2 divides a 48 MHz or 30 MHz clock by (delay + 1). We prefer the
 * lower-jitter 48 MHz clock, but only when the required delay divides evenly
 * and fits MAX_SAMPLE_DELAY; otherwise we fall back to 30 MHz (this is what
 * forces 20/25 kHz onto the 30 MHz clock). Throws if the rate is unachievable.
 */
export function encodeSampleRate(
  sampleRate: number,
  wide = false,
): StartConfig {
  if (sampleRate <= 0) throw new Error(`Invalid sample rate: ${sampleRate}`);

  const widthFlag = wide
    ? CMD_START_FLAGS_SAMPLE_16BIT
    : CMD_START_FLAGS_SAMPLE_8BIT;

  const candidates: Array<{ base: number; clkFlag: number }> = [
    { base: CLK_48MHZ, clkFlag: CMD_START_FLAGS_CLK_48MHZ },
    { base: CLK_30MHZ, clkFlag: CMD_START_FLAGS_CLK_30MHZ },
  ];

  for (const { base, clkFlag } of candidates) {
    if (base % sampleRate !== 0) continue;
    const delay = base / sampleRate - 1;
    if (delay < 0 || delay > MAX_SAMPLE_DELAY) continue;
    return {
      flags: widthFlag | clkFlag,
      sampleDelayH: (delay >> 8) & 0xff,
      sampleDelayL: delay & 0xff,
      baseClock: base,
      delay,
    };
  }

  throw new Error(
    `Sample rate ${sampleRate} Hz is not achievable by the fx2lafw clock divider`,
  );
}

/** Human-readable label, e.g. 24_000_000 -> "24 MHz". */
export function formatSampleRate(hz: number): string {
  if (hz >= 1_000_000) return `${hz / 1_000_000} MHz`;
  if (hz >= 1_000) return `${hz / 1_000} kHz`;
  return `${hz} Hz`;
}

/**
 * Rough sustained USB throughput ceiling for high-speed bulk (bytes/sec).
 * Real-world fx2lafw tops out well under the 60 MB/s theoretical max; we use a
 * conservative figure to warn before samples start dropping.
 */
export const SUSTAINED_USB_BYTES_PER_SEC = 30_000_000;

/** Returns a warning string if the rate/width likely exceeds USB bandwidth. */
export function bandwidthWarning(
  sampleRate: number,
  wide = false,
): string | null {
  const bytesPerSample = wide ? 2 : 1;
  const bytesPerSec = sampleRate * bytesPerSample;
  if (bytesPerSec > SUSTAINED_USB_BYTES_PER_SEC) {
    return `${formatSampleRate(sampleRate)} needs ~${(bytesPerSec / 1e6).toFixed(0)} MB/s; USB may drop samples.`;
  }
  return null;
}
