// SUMP/OLS device driver: identify, arm, read the dump.
//
// The one structural difference from the FX2 path is that SUMP is a *one-shot
// buffered dump, newest sample first*. The device captures into its own memory
// and only then uploads, back to front, so there is nothing to follow live: we
// pre-allocate the whole buffer, fill it backwards as bytes land, and hand it
// over in one `onData` at the end (the same thing libsigrok's ols driver does).

import type {
  Acquisition,
  AcquisitionRequest,
  CaptureCallbacks,
  DeviceCapabilities,
  LogicDevice,
} from "../device/types";
import type { SerialConnection } from "./serialPort";
import { parseMetadata, type SumpMetadata } from "./metadata";
import {
  resolveProfile,
  SUMP_CLOCK_HZ,
  type ResolvedProfile,
} from "./profiles";
import {
  CMD_CAPTURE_DELAYCOUNT,
  CMD_CAPTURE_READCOUNT,
  CMD_ID,
  CMD_METADATA,
  CMD_RUN,
  CMD_SET_DIVIDER,
  CMD_SET_FLAGS,
  ID_REPLIES,
  MAX_NARROW_SAMPLES,
  captureSizeCommand,
  encodeCounts,
  encodeDivider,
  encodeFlags,
  longCommand,
  resetSequence,
  resolveRate,
  triggerCommands,
  triggerStage,
  type Counts,
  type TriggerStage,
} from "./protocol";

/** Only channel group 0 — one byte per sample, exactly CaptureBuffer's format. */
const GROUP_0_ONLY = 0x01;

/** How long to wait for the 4-byte reply to `CMD_ID`. */
const ID_TIMEOUT_MS = 500;
/** Silence that ends the metadata TLV stream (a device with no `0x04` support
 *  answers nothing at all, so this is also the "not supported" path). */
const METADATA_IDLE_MS = 300;
/** Hard bound on the whole metadata exchange. */
const METADATA_TOTAL_MS = 2000;

/**
 * Silence that ends a dump. Generous on purpose: the normal path finishes on the
 * expected byte count, so this only fires when a device sends fewer bytes than
 * asked — and at 115200 baud a device pausing between 512-byte blocks can
 * easily be quiet for a couple of hundred ms without anything being wrong.
 */
const DUMP_IDLE_MS = 500;
/** Extra grace before the first byte when the device is waiting on a trigger. */
const TRIGGER_WAIT_MS = 60_000;
/** Ceiling on the wait for the first byte, so a wedged device still gives up. */
const MAX_ARM_WAIT_MS = 600_000;

/** Progress is reported per this many bytes, not per chunk. */
const PROGRESS_STEP = 1024;

/** Rates offered where the divider can produce them. Resolved through the
 *  divider before being shown, so every entry is a rate the device will use. */
const NICE_RATES = [
  10_000, 20_000, 25_000, 50_000, 100_000, 200_000, 250_000, 500_000, 1_000_000,
  2_000_000, 4_000_000, 5_000_000, 8_000_000, 10_000_000, 16_000_000,
  20_000_000, 25_000_000, 50_000_000, 100_000_000,
];

/** Sample-count options, before clamping to the device's memory. */
const LIMIT_STEPS = [
  1024, 4096, 16_384, 65_536, 262_144, 1_048_576, 4_194_304, 16_777_216,
];

/**
 * The smallest divider that stays within `maxRate`. Rounding to the *nearest*
 * divider can overshoot a ceiling like the JTAGulator's 1.2 MSa/s, so the list
 * and every resolved rate are floored through this instead.
 */
function minDividerFor(clockHz: number, maxRate: number): number {
  return Math.max(0, Math.ceil(clockHz / Math.max(1, maxRate)) - 1);
}

/** Selectable rates for a clock/ceiling pair: nice values resolved through the
 *  divider, deduped, plus the ceiling itself so a slow device isn't cut short. */
export function buildSampleRates(clockHz: number, maxRate: number): number[] {
  const floor = minDividerFor(clockHz, maxRate);
  const out = new Set<number>();
  for (const target of [...NICE_RATES, maxRate]) {
    if (target > maxRate) continue;
    const divider = Math.max(floor, encodeDivider(clockHz, target));
    out.add(resolveRate(clockHz, divider));
  }
  out.add(resolveRate(clockHz, floor)); // the ceiling
  return [...out].filter((r) => r > 0).sort((a, b) => a - b);
}

/** Sample counts the device can actually hold, as multiples of 4 (the protocol's
 *  count granularity). Devices without the 32-bit count commands are also capped
 *  by what the 16-bit `CMD_CAPTURE_SIZE` can express. */
export function buildSampleLimits(
  sampleMemory: number,
  wideCounts: boolean,
): number[] {
  const bound = wideCounts
    ? sampleMemory
    : Math.min(sampleMemory, MAX_NARROW_SAMPLES);
  const cap = Math.max(4, Math.floor(bound / 4) * 4);
  return [...LIMIT_STEPS.filter((n) => n < cap), cap];
}

interface CapturePlan {
  divider: number;
  rate: number;
  counts: Counts;
  stage: TriggerStage;
  /** Bytes the device will send, and the length of the buffer we allocate. */
  samples: number;
}

export class SumpDevice implements LogicDevice {
  readonly label: string;
  readonly capabilities: DeviceCapabilities;
  private readonly minDivider: number;

  constructor(
    readonly conn: SerialConnection,
    readonly profile: ResolvedProfile,
    readonly metadata: SumpMetadata,
    private readonly onClosed?: (dev: SumpDevice) => void,
  ) {
    this.minDivider = minDividerFor(SUMP_CLOCK_HZ, profile.maxSampleRate);
    // Spelled out rather than "8 ch, 262,144 Sa": this is a status line read
    // once on connect, and "Sa" (sigrok's abbreviation for samples) reads like
    // a word that got cut off.
    const ch = profile.channels;
    this.label = `${profile.name} — ${ch} channel${ch === 1 ? "" : "s"}, ${profile.sampleMemory.toLocaleString()} samples`;
    this.capabilities = {
      channels: profile.channels,
      sampleRates: buildSampleRates(SUMP_CLOCK_HZ, profile.maxSampleRate),
      sampleLimits: buildSampleLimits(profile.sampleMemory, profile.wideCounts),
      hardwareTrigger: profile.hardwareTrigger,
      // One buffered dump, newest-first: nothing to show until it is complete,
      // and no way to capture without end.
      streaming: false,
      continuous: false,
    };
  }

  private dividerFor(hz: number): number {
    return Math.max(this.minDivider, encodeDivider(SUMP_CLOCK_HZ, hz));
  }

  resolveSampleRate(hz: number): number {
    return resolveRate(SUMP_CLOCK_HZ, this.dividerFor(hz));
  }

  /** Work out every value the arm sequence needs, so run() is pure I/O. */
  plan(req: AcquisitionRequest): CapturePlan {
    const divider = this.dividerFor(req.sampleRate);
    const bound = this.profile.wideCounts
      ? this.profile.sampleMemory
      : Math.min(this.profile.sampleMemory, MAX_NARROW_SAMPLES);
    // Round *down* to the count granularity, so the device never overshoots the
    // memory we clamped to.
    const want = Math.max(
      4,
      Math.floor(Math.min(req.sampleLimit, bound) / 4) * 4,
    );
    // delaycount == readcount: everything post-trigger, so the trigger lands at
    // sample 0 and the app needs no pre/post-trigger control.
    const counts = encodeCounts(want, want);
    // Only drive the trigger unit where the device has one; elsewhere start
    // immediately and let the software trigger find the condition afterwards.
    const stage: TriggerStage = this.profile.hardwareTrigger
      ? (triggerStage(req.trigger) ?? START_IMMEDIATELY)
      : START_IMMEDIATELY;
    return {
      divider,
      rate: resolveRate(SUMP_CLOCK_HZ, divider),
      counts,
      stage,
      samples: counts.samples,
    };
  }

  /** Configure and start a capture. */
  async arm(plan: CapturePlan): Promise<void> {
    const { conn } = this;
    // A device may be part-way through a 5-byte long command, so open with five
    // resets and throw away whatever it says in reply.
    await conn.write(resetSequence());
    await conn.drain();

    for (const cmd of triggerCommands(plan.stage)) await conn.write(cmd);
    await conn.write(longCommand(CMD_SET_DIVIDER, plan.divider));
    if (plan.counts.readCount > 0xffff) {
      // Only reachable on a profile with wideCounts (plan() clamps otherwise):
      // a device that doesn't implement these opcodes may not consume their
      // payload bytes and would be desynced for good.
      await conn.write(
        longCommand(CMD_CAPTURE_READCOUNT, plan.counts.readCount),
      );
      await conn.write(
        longCommand(CMD_CAPTURE_DELAYCOUNT, plan.counts.delayCount),
      );
    } else {
      await conn.write(captureSizeCommand(plan.counts));
    }
    // Mandatory, not an optimisation: a device left with groups 2 and 3 enabled
    // pads every sample with dummy bytes.
    await conn.write(
      longCommand(CMD_SET_FLAGS, encodeFlags({ groups: GROUP_0_ONLY })),
    );
    await conn.write(new Uint8Array([CMD_RUN]));
  }

  /** Best-effort abort: the reset also stops a dump already in progress. */
  async reset(): Promise<void> {
    try {
      await this.conn.write(resetSequence());
    } catch {
      /* port may be gone */
    }
  }

  acquire(req: AcquisitionRequest, cb: CaptureCallbacks): Acquisition {
    return new SumpAcquisition(this, req, cb);
  }

  async close(): Promise<void> {
    await this.reset();
    await this.conn.close();
    this.onClosed?.(this);
  }
}

/** An empty mask: the capture starts the moment it is armed. */
const START_IMMEDIATELY: TriggerStage = { mask: 0, value: 0 };

class SumpAcquisition implements Acquisition {
  private stopped = false;

  constructor(
    private readonly dev: SumpDevice,
    private readonly req: AcquisitionRequest,
    private readonly cb: CaptureCallbacks,
  ) {}

  async run(): Promise<void> {
    try {
      const plan = this.dev.plan(this.req);
      await this.dev.arm(plan);
      await this.readDump(plan);
    } catch (err) {
      if (!this.stopped) this.cb.onError?.(err);
    } finally {
      await this.dev.reset(); // leave the device idle, not mid-upload
    }
  }

  stop(): void {
    this.stopped = true;
    // Unblock the read we are parked in *first*: the loop only checks `stopped`
    // between reads, and the wait for a first byte is measured in seconds (or
    // minutes with a trigger armed), so without this Stop appears to do nothing.
    this.dev.conn.interrupt();
    // Then tell the device to abandon the capture it is taking.
    void this.dev.reset();
  }

  /**
   * Read the dump into a pre-allocated buffer, filling it *backwards*: the first
   * byte off the wire is the newest sample. An early stop therefore leaves a
   * contiguous newest-N run at the end of the buffer, which is a valid capture
   * on its own — hence the single `onData` over that tail.
   */
  private async readDump(plan: CapturePlan): Promise<void> {
    const expected = plan.samples;
    const raw = new Uint8Array(expected);
    let collected = 0;
    let reported = 0;
    let started = false;

    // Nothing arrives until the device has filled its own memory, so the wait
    // for the first byte scales with the capture itself — at 20 kHz a 65 K
    // capture legitimately takes 3 s before a single byte appears — plus a long
    // grace when it is also waiting for a trigger to fire.
    const captureMs = (expected / Math.max(1, plan.rate)) * 1000;
    const armWait = Math.min(
      MAX_ARM_WAIT_MS,
      5000 + captureMs * 3 + (plan.stage.mask !== 0 ? TRIGGER_WAIT_MS : 0),
    );

    while (collected < expected && !this.stopped) {
      const chunk = await this.dev.conn.read(started ? DUMP_IDLE_MS : armWait);
      if (!chunk || chunk.length === 0) break; // armed-but-silent, or dump ended
      started = true;
      const n = Math.min(chunk.length, expected - collected);
      for (let i = 0; i < n; i++) {
        raw[expected - 1 - collected - i] = chunk[i];
      }
      collected += n;
      if (collected - reported >= PROGRESS_STEP || collected === expected) {
        reported = collected;
        this.cb.onProgress?.(collected);
      }
    }

    if (collected === 0) {
      if (this.stopped) return;
      throw new Error(
        "The device never sent any samples. If a trigger is set, the condition may not have occurred — clear it or press Stop.",
      );
    }
    this.cb.onProgress?.(collected);
    this.cb.onData(raw.subarray(expected - collected));
  }
}

/** Read exactly `n` bytes, or throw if the device goes quiet first. */
async function readExactly(
  conn: SerialConnection,
  n: number,
  timeoutMs: number,
): Promise<Uint8Array> {
  const out = new Uint8Array(n);
  let got = 0;
  while (got < n) {
    const chunk = await conn.read(timeoutMs);
    if (!chunk || chunk.length === 0) break;
    const take = Math.min(chunk.length, n - got);
    out.set(chunk.subarray(0, take), got);
    got += take;
  }
  if (got < n) {
    throw new Error(
      "No reply from the serial port. Is this a SUMP/OLS device, and is it in logic-analyzer mode?",
    );
  }
  return out;
}

/** Read the `0x04` TLV stream until it terminates, or the device goes quiet. */
async function readMetadata(conn: SerialConnection): Promise<SumpMetadata> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  const deadline = Date.now() + METADATA_TOTAL_MS;
  let parsed = parseMetadata(new Uint8Array(0));
  while (!parsed.complete && Date.now() < deadline) {
    const chunk = await conn.read(METADATA_IDLE_MS);
    if (!chunk || chunk.length === 0) break; // no 0x04 support, or done sending
    chunks.push(chunk);
    total += chunk.length;
    const all = new Uint8Array(total);
    let at = 0;
    for (const c of chunks) {
      all.set(c, at);
      at += c.length;
    }
    parsed = parseMetadata(all);
  }
  return parsed.meta;
}

/**
 * Identify an open port. Rejects anything that doesn't answer `CMD_ID` with a
 * SUMP identity — a wrong port pick is otherwise indistinguishable from a device
 * that simply never triggers.
 */
export async function identifySump(
  conn: SerialConnection,
  onClosed?: (dev: SumpDevice) => void,
): Promise<SumpDevice> {
  await conn.write(resetSequence());
  await conn.drain();

  await conn.write(new Uint8Array([CMD_ID]));
  const id = await readExactly(conn, 4, ID_TIMEOUT_MS);
  const text = String.fromCharCode(...id);
  if (!ID_REPLIES.includes(text)) {
    throw new Error(
      `Not a SUMP device: it answered "${text}" instead of an OLS identity. Pick the port your logic analyzer is on, and put it in SUMP mode.`,
    );
  }

  await conn.write(new Uint8Array([CMD_METADATA]));
  const meta = await readMetadata(conn);
  return new SumpDevice(conn, resolveProfile(meta), meta, onClosed);
}
