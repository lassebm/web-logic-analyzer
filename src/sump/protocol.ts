// SUMP/OLS wire protocol — pure encoding, no I/O.
//
// Sources: the sump.org SUMP protocol description, the "Logic Sniffer Demon Core
// FPGA Specification" rev 1.03, libsigrok's openbench-logic-sniffer driver
// (protocol.{c,h}), and the firmware of Bus Pirate v3/v5, AGLA and
// ESP32-Bit-Pirate.
//
// Command payloads are little-endian while `0x04` metadata is big-endian, and
// read/delay counts are in units of 4 samples minus one — the two facts that
// bite every implementation.

import type { TriggerSpec } from "../model/trigger";

// --- Commands ---

/** Short (1-byte) commands. */
export const CMD_RESET = 0x00;
/** Arm the basic trigger and start the capture ("run"). */
export const CMD_RUN = 0x01;
export const CMD_ID = 0x02;
export const CMD_METADATA = 0x04;

/** Long (opcode + 4 little-endian payload bytes) commands. */
export const CMD_SET_DIVIDER = 0x80;
/** 16-bit read count and delay count packed into one command. */
export const CMD_CAPTURE_SIZE = 0x81;
export const CMD_SET_FLAGS = 0x82;
/** 32-bit counts — only on devices known to implement them (see profiles). */
export const CMD_CAPTURE_DELAYCOUNT = 0x83;
export const CMD_CAPTURE_READCOUNT = 0x84;

/** Basic trigger stage 0. Stages 1–3 follow at +4 each (so 0xC0–0xCF), with
 *  the stage index in byte 2 of the config payload — unused: the app's trigger
 *  is one AND of conditions, which is exactly one stage. */
export const CMD_TRIGGER_MASK_0 = 0xc0;
export const CMD_TRIGGER_VALUE_0 = 0xc1;
export const CMD_TRIGGER_CONFIG_0 = 0xc2;

/** "This stage starts the capture": bit 3 of the config payload's *fourth*
 *  byte, i.e. bit 27 of the u32 (libsigrok's TRIGGER_START). */
export const TRIGGER_START = 0x08 << 24;

/** The divider field is 24-bit. */
export const MAX_DIVIDER = 0x00ffffff;
/** `CMD_CAPTURE_SIZE` packs two 16-bit counts, so 65536 × 4 samples. */
export const MAX_NARROW_SAMPLES = 65_536 * 4;

/** Accepted replies to `CMD_ID`: "SLA1" as sent, and the byte-reversed form
 *  some firmwares emit. Nothing else is a SUMP device. */
export const ID_REPLIES = ["1ALS", "1SLO"];

// --- Encoding ---

/**
 * Divider for a requested rate: `clock / rate − 1`, rounded so an arbitrary
 * request still lands on the nearest achievable rate rather than being refused.
 * Achievable rates are a divider continuum, not a table.
 */
export function encodeDivider(clockHz: number, rateHz: number): number {
  if (clockHz <= 0 || rateHz <= 0) {
    throw new Error(`Invalid clock/rate: ${clockHz}/${rateHz}`);
  }
  const divider = Math.round(clockHz / rateHz) - 1;
  return Math.min(MAX_DIVIDER, Math.max(0, divider));
}

/** The rate a divider actually produces. This — not the request — is what goes
 *  into `CaptureBuffer`, or every time axis is wrong. */
export function resolveRate(clockHz: number, divider: number): number {
  return Math.round(clockHz / (divider + 1));
}

export interface Counts {
  /** Value to send: `ceil(samples / 4) − 1`. */
  readCount: number;
  /** Post-trigger samples, same encoding. */
  delayCount: number;
  /** Samples the device will actually take, after the ÷4 rounding. */
  samples: number;
}

/**
 * Encode a sample count. Both counts are "groups of four samples, minus one",
 * so 1..4 samples all encode as 0 and the device takes 4.
 *
 * `delaySamples` is how many samples to keep *after* the trigger; passing the
 * full count (what we do) opens the window at the trigger, which is why the app
 * needs no pre/post-trigger control.
 */
export function encodeCounts(samples: number, delaySamples: number): Counts {
  const groups = Math.max(1, Math.ceil(samples / 4));
  const delayGroups = Math.max(
    1,
    Math.min(groups, Math.ceil(delaySamples / 4)),
  );
  return {
    readCount: groups - 1,
    delayCount: delayGroups - 1,
    samples: groups * 4,
  };
}

interface FlagOptions {
  /** Bitmask of *enabled* channel groups; bit 0 = D0–D7. */
  groups: number;
  rle?: boolean;
  externalClock?: boolean;
}

/**
 * The flags word. Bits 2–5 *disable* channel groups, so group-0-only is 0x38 —
 * and sending it is mandatory, not an optimisation: a Bus Pirate 5 left with
 * groups 2 and 3 enabled pads every sample with a 0x55/0xAA dummy pattern.
 *
 * RLE (bit 8) stays off: sigrok documents its OLS support as broken and the
 * compatibles disagree on whether the run length is inclusive.
 */
export function encodeFlags({
  groups,
  rle = false,
  externalClock = false,
}: FlagOptions): number {
  let flags = ~(groups << 2) & 0x3c;
  if (rle) flags |= 1 << 8;
  if (externalClock) flags |= 1 << 6;
  return flags;
}

/** A long command: opcode followed by a little-endian u32 payload. */
export function longCommand(op: number, value: number): Uint8Array {
  const out = new Uint8Array(5);
  out[0] = op;
  out[1] = value & 0xff;
  out[2] = (value >>> 8) & 0xff;
  out[3] = (value >>> 16) & 0xff;
  out[4] = (value >>> 24) & 0xff;
  return out;
}

/** `CMD_CAPTURE_SIZE`: two little-endian u16s in one long command. */
export function captureSizeCommand(counts: Counts): Uint8Array {
  return longCommand(
    CMD_CAPTURE_SIZE,
    ((counts.delayCount & 0xffff) << 16) | (counts.readCount & 0xffff),
  );
}

export interface TriggerStage {
  /** Channels taking part, one bit each. */
  mask: number;
  /** Expected level per masked channel. */
  value: number;
}

/**
 * The app's trigger spec as a basic-trigger stage.
 *
 * Null when it can't be expressed: a SUMP stage matches a *level pattern*, so
 * any rising/falling/either condition falls back to the software trigger. An
 * empty spec still yields a stage — mask 0 — because the device needs one to
 * start capturing at all (libsigrok's "force trigger at stage 0").
 */
export function triggerStage(spec: TriggerSpec): TriggerStage | null {
  let mask = 0;
  let value = 0;
  for (const c of spec.conditions) {
    if (c.edge !== "high" && c.edge !== "low") return null;
    mask |= 1 << c.channel;
    if (c.edge === "high") value |= 1 << c.channel;
  }
  return { mask, value };
}

/** The three commands for the stage, which the FPGA wants back to back in this
 *  order. The start bit goes on the config word: nothing follows this stage. */
export function triggerCommands({ mask, value }: TriggerStage): Uint8Array[] {
  return [
    longCommand(CMD_TRIGGER_MASK_0, mask),
    longCommand(CMD_TRIGGER_VALUE_0, value),
    longCommand(CMD_TRIGGER_CONFIG_0, TRIGGER_START),
  ];
}

/**
 * The five `CMD_RESET` bytes every exchange opens with. A device may be part-way
 * through consuming a 5-byte long command, so one reset byte can be swallowed as
 * payload; five guarantees at least one lands as an opcode.
 */
export function resetSequence(): Uint8Array {
  return new Uint8Array(5).fill(CMD_RESET);
}
