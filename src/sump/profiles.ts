// Per-device knowledge that a device's own `0x04` metadata can't supply.
//
// Rows are fallbacks, never overrides: metadata always wins. Getting one wrong
// degrades gently — a device wrongly credited with a hardware trigger just
// starts capturing immediately, and findTrigger() still finds the condition.
//
// The rules follow libsigrok's openbench-logic-sniffer driver, the client all
// these devices were tested against; AGENTS.md lists which rules and why.

import type { SumpMetadata } from "./metadata";
import { NUM_CHANNELS } from "../device/channels";

/**
 * The clock every SUMP device divides; there is no per-device one. A device may
 * advertise more (the OLS's 200 MHz is its demux mode, which we don't drive),
 * but a divider only divides, so this caps every rate.
 */
export const SUMP_CLOCK_HZ = 100_000_000;

/**
 * Reported memory above which `0x84`/`0x83` are assumed to exist — the only
 * input to `wideCounts`. No device needs an exception: the 16-bit
 * `CMD_CAPTURE_SIZE` reaches 262144 samples, so anything at or below this could
 * never use the 32-bit path anyway, and anything above it is a device PulseView
 * would send them to as well.
 */
export const WIDE_COUNT_MEMORY_THRESHOLD = 256 * 1024;

interface SumpProfile {
  /** Matched against the metadata device name. */
  match: RegExp;
  sampleMemory?: number;
  maxSampleRate?: number;
  channels?: number;
  /** The device waits for a level condition itself. Alone in this interface it
   *  changes what we send: without it the driver arms a start-immediately stage
   *  and leaves the trigger to `model/trigger.ts`. */
  hardwareTrigger?: boolean;
}

export interface ResolvedProfile {
  name: string;
  sampleMemory: number;
  maxSampleRate: number;
  channels: number;
  hardwareTrigger: boolean;
  wideCounts: boolean;
}

/** 4 KiB is the smallest depth in the family, so an unknown device gets an
 *  option list it can definitely satisfy. */
export const GENERIC_PROFILE: ResolvedProfile = {
  name: "SUMP device",
  sampleMemory: 4096,
  maxSampleRate: SUMP_CLOCK_HZ,
  channels: NUM_CHANNELS,
  hardwareTrigger: false,
  wideCounts: false,
};

const SUMP_PROFILES: SumpProfile[] = [
  {
    // "Open Logic Sniffer v1.01" — the reference implementation.
    match: /logic sniffer/i,
    maxSampleRate: SUMP_CLOCK_HZ,
    sampleMemory: 24_576,
    hardwareTrigger: true,
  },
  {
    // Bus Pirate 5/6: 8 channels, ~131 K samples, 62.5 MSPS, single-pin level
    // trigger.
    match: /bus\s*pirate\s*[56]/i,
    maxSampleRate: 62_500_000,
    sampleMemory: 131_072,
    channels: 8,
    hardwareTrigger: true,
  },
  {
    // Bus Pirate v3/v4: 4096 samples at up to 1 MHz on 5 channels. Ignores the
    // flags word, which is harmless — we only ever ask for group 0.
    match: /bus\s*pirate/i,
    maxSampleRate: 1_000_000,
    sampleMemory: 4096,
    channels: 5,
    hardwareTrigger: true,
  },
  {
    // Logic Shrimp: 4 channels, 20 MHz, 256 KiSa. Its firmware publishes
    // metadata that doesn't match, so these fill the gaps — the same three
    // values libsigrok's own Shrimp quirk supplies.
    match: /shrimp/i,
    maxSampleRate: 20_000_000,
    sampleMemory: 262_144,
    channels: 4,
    hardwareTrigger: true,
  },
  {
    // JTAGulator: 24 channels (we use D0–D7), 1024 Sa, 1.2 MSa/s, level triggers.
    match: /jtagulator/i,
    maxSampleRate: 1_200_000,
    sampleMemory: 1024,
    hardwareTrigger: true,
  },
  {
    // AGLA, the Arduino sketch: 5–6 channels, ≤4 MHz. Its buffer depends on the
    // MCU (532 B on an ATmega168, 7 KiB on a 2560), so metadata decides depth.
    match: /agla|arduino/i,
    maxSampleRate: 4_000_000,
    sampleMemory: 532,
    channels: 6,
    hardwareTrigger: false,
  },
  {
    // ESP32-Bit-Pirate discards the 0xC0–0xCF trigger commands, so it genuinely
    // has no hardware trigger — this row is why the UI can say so rather than
    // guess. Its depth is heap-derived, so metadata decides that.
    match: /esp32|bit\s*pirate/i,
    channels: 8,
    hardwareTrigger: false,
  },
];

/** First profile whose name pattern matches, or null. */
function matchProfile(name: string | undefined): SumpProfile | null {
  if (!name) return null;
  return SUMP_PROFILES.find((p) => p.match.test(name)) ?? null;
}

/**
 * Merge a device's metadata over the matched profile over the generic default.
 * Metadata always wins — a profile only fills in what the firmware didn't say.
 */
export function resolveProfile(meta: SumpMetadata): ResolvedProfile {
  const profile = matchProfile(meta.name);
  // A reported zero means "didn't say", not "has none" — firmware that omits a
  // value by writing 0 is common enough that libsigrok guards it too. Taken
  // literally it yields a device with no channels, or a 1 Hz rate list.
  const first = (...vals: (number | undefined)[]) =>
    vals.find((v) => v !== undefined && v > 0)!;
  const sampleMemory = first(
    meta.sampleMemory,
    profile?.sampleMemory,
    GENERIC_PROFILE.sampleMemory,
  );
  const maxSampleRate = first(
    meta.maxSampleRate,
    profile?.maxSampleRate,
    GENERIC_PROFILE.maxSampleRate,
  );

  return {
    name: meta.name ?? GENERIC_PROFILE.name,
    sampleMemory,
    // However high the device claims it can go, the divider can only divide.
    maxSampleRate: Math.min(maxSampleRate, SUMP_CLOCK_HZ),
    channels: Math.min(
      NUM_CHANNELS,
      first(meta.probes, profile?.channels, GENERIC_PROFILE.channels),
    ),
    hardwareTrigger:
      profile?.hardwareTrigger ?? GENERIC_PROFILE.hardwareTrigger,
    wideCounts: sampleMemory > WIDE_COUNT_MEMORY_THRESHOLD,
  };
}
