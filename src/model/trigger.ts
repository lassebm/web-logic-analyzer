import type { CaptureBuffer } from "./capture";

export type TriggerEdge = "rising" | "falling" | "high" | "low" | "any";

export interface ChannelTrigger {
  channel: number;
  edge: TriggerEdge;
}

/**
 * Software trigger, mirroring sigrok's model (fx2lafw has no hardware trigger).
 * A match requires every listed condition to hold at the same sample index.
 * Level conditions (high/low) match on the sample itself; edge conditions
 * match on a transition from the previous sample.
 */
export interface TriggerSpec {
  conditions: ChannelTrigger[];
}

function conditionMet(
  cond: ChannelTrigger,
  prev: number | null,
  cur: number,
): boolean {
  const curBit = (cur >> cond.channel) & 1;
  const prevBit = prev === null ? curBit : (prev >> cond.channel) & 1;
  switch (cond.edge) {
    case "high":
      return curBit === 1;
    case "low":
      return curBit === 0;
    case "rising":
      return prevBit === 0 && curBit === 1;
    case "falling":
      return prevBit === 1 && curBit === 0;
    case "any":
      return prevBit !== curBit;
  }
}

/**
 * Find the first sample index at which all trigger conditions hold. Returns 0
 * for an empty spec (trigger origin = start of capture) and -1 if never met.
 */
export function findTrigger(buf: CaptureBuffer, spec: TriggerSpec): number {
  if (spec.conditions.length === 0) return 0;
  const n = buf.sampleCount;
  for (let i = 0; i < n; i++) {
    const cur = buf.byteAt(i);
    const prev = i === 0 ? null : buf.byteAt(i - 1);
    if (spec.conditions.every((c) => conditionMet(c, prev, cur))) return i;
  }
  return -1;
}
