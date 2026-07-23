import type { CaptureBuffer } from "../model/capture";
import type {
  Annotation,
  Decoder,
  DecoderContext,
  MatchCode,
  Packet,
  PinState,
  StackedContext,
  WaitCondition,
  WaitInput,
} from "./types";

/** A single-channel wait condition, e.g. `cond(0, 'f')`; avoids inline `as WaitInput`. */
export function cond(channel: number, code: MatchCode): WaitCondition {
  return { [channel]: code };
}

export interface DecodeResult {
  annotations: Annotation[];
  packets: Packet[];
}

/** channelMap[logicalChannel] = physical capture channel (0..7). */
export type ChannelMap = number[];

/**
 * Advance the decoder to (at least) absolute sample `target` by yielding a
 * `{ skip }` wait, and return the pin state there. A shared primitive so
 * decoders that sample at computed offsets (UART bit centres, CAN bit centres)
 * don't each re-derive it. Use as `yield* skipToSample(ctx, target)`.
 */
export function* skipToSample(
  ctx: DecoderContext,
  target: number,
): Generator<WaitInput, PinState, PinState> {
  const skip = Math.max(1, Math.round(target) - ctx.samplenum);
  return yield { skip };
}

function bitAt(buf: CaptureBuffer, physChannel: number, index: number): 0 | 1 {
  return buf.channelValueAt(physChannel, index);
}

function matchLevelOrEdge(
  buf: CaptureBuffer,
  physChannel: number,
  index: number,
  code: MatchCode,
): boolean {
  const cur = bitAt(buf, physChannel, index);
  const prev = index > 0 ? bitAt(buf, physChannel, index - 1) : cur;
  switch (code) {
    case "h":
      return cur === 1;
    case "l":
      return cur === 0;
    case "r":
      return prev === 0 && cur === 1;
    case "f":
      return prev === 1 && cur === 0;
    case "e":
      return prev !== cur;
    case "s":
      return prev === cur;
  }
}

function conditionMatchesAt(
  buf: CaptureBuffer,
  channelMap: ChannelMap,
  cond: WaitCondition,
  index: number,
): boolean {
  if ("skip" in cond) return false; // skip handled by target arithmetic
  for (const key of Object.keys(cond)) {
    const logical = Number(key);
    const code = (cond as Record<number, MatchCode>)[logical];
    if (!matchLevelOrEdge(buf, channelMap[logical], index, code)) return false;
  }
  return true;
}

const EDGE_CODES = new Set(["r", "f", "e"]);
const STABLE_CODES = new Set(["s"]);

function hasCode(cond: WaitCondition, codes: Set<string>): boolean {
  for (const k of Object.keys(cond)) {
    if (k === "skip") continue;
    if (codes.has((cond as Record<number, MatchCode>)[Number(k)])) return true;
  }
  return false;
}

/** First index into `transitions` whose sample value is strictly > `current`. */
function upperBound(transitions: Uint32Array, current: number): number {
  let lo = 0;
  let hi = transitions.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (transitions[mid] > current) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

/**
 * Earliest sample index (> current) satisfying a single condition, or Infinity.
 *
 * - `skip`: a fixed offset, O(1).
 * - Conditions containing a real edge (r/f/e): matches occur only at transition
 *   samples, so we scan the transition index (jumping over constant runs).
 * - Level-only conditions (h/l): check current+1, else the next transition that
 *   establishes the level.
 * - Conditions containing 's' (stable) may match at non-transition samples, so
 *   they fall back to a linear scan (unused by the bundled decoders).
 */
function nextMatch(
  buf: CaptureBuffer,
  transitions: Uint32Array,
  channelMap: ChannelMap,
  cond: WaitCondition,
  current: number,
  n: number,
): number {
  if ("skip" in cond) {
    const t = current + cond.skip;
    return t < n ? t : Infinity;
  }

  if (hasCode(cond, STABLE_CODES)) {
    for (let idx = current + 1; idx < n; idx++) {
      if (conditionMatchesAt(buf, channelMap, cond, idx)) return idx;
    }
    return Infinity;
  }

  const edgeDriven = hasCode(cond, EDGE_CODES);
  if (!edgeDriven) {
    const s = current + 1;
    if (s < n && conditionMatchesAt(buf, channelMap, cond, s)) return s;
  }

  for (let k = upperBound(transitions, current); k < transitions.length; k++) {
    const s = transitions[k];
    if (s >= n) break;
    if (conditionMatchesAt(buf, channelMap, cond, s)) return s;
  }
  return Infinity;
}

/**
 * Find the earliest sample index (> current) satisfying any condition, and mark
 * which conditions matched there. Returns -1 when no condition can be met.
 */
function advance(
  buf: CaptureBuffer,
  transitions: Uint32Array,
  channelMap: ChannelMap,
  conds: WaitCondition[],
  current: number,
  matchedOut: boolean[],
  limit: number,
): number {
  const candidates = conds.map((c) =>
    nextMatch(buf, transitions, channelMap, c, current, limit),
  );

  let best = Infinity;
  for (const c of candidates) if (c < best) best = c;
  if (!isFinite(best)) return -1;

  for (let i = 0; i < conds.length; i++) matchedOut[i] = candidates[i] === best;
  return best;
}

/** Edge (transition) sample indices within [start, end), scanned directly. */
function windowTransitions(
  buf: CaptureBuffer,
  start: number,
  end: number,
): Uint32Array {
  const idx: number[] = [];
  for (let i = Math.max(1, start); i < end; i++) {
    if (buf.byteAt(i) !== buf.byteAt(i - 1)) idx.push(i);
  }
  return Uint32Array.from(idx);
}

/**
 * Run a decoder over a capture buffer. `channelMap` maps the decoder's logical
 * channels to physical capture channels; `options` supplies option values.
 *
 * wait() advances via the buffer's transition index (binary search), jumping
 * over constant runs, so decode cost scales with the number of edges rather
 * than the number of samples.
 *
 * An optional `range` limits decoding to samples [start, end) and builds the
 * edge index by scanning just that window — used for live, in-view decoding
 * during a capture so cost is bounded by what's on screen, not the whole buffer.
 * A decoder started mid-stream resynchronises at the next framing event (e.g. a
 * UART start bit), so a windowed pass is a preview; the full decode runs on stop.
 */
export function runDecoder(
  decoder: Decoder,
  buf: CaptureBuffer,
  channelMap: ChannelMap,
  options: Record<string, string | number>,
  range?: { start: number; end: number },
): DecodeResult {
  const annotations: Annotation[] = [];
  const packets: Packet[] = [];
  const matched: boolean[] = [];

  if (!decoder.decode) return { annotations, packets };

  const state = { samplenum: 0 };
  const ctx: DecoderContext = {
    samplerate: buf.sampleRate,
    get samplenum() {
      return state.samplenum;
    },
    get matched() {
      return matched;
    },
    options,
    pin(channel: number) {
      return bitAt(buf, channelMap[channel], state.samplenum);
    },
    put(startSample, endSample, annClass, texts) {
      annotations.push({ startSample, endSample, annClass, texts });
    },
    emit(startSample, endSample, type, data) {
      packets.push({ startSample, endSample, type, data });
    },
  };

  if (buf.sampleCount === 0) return { annotations, packets };

  const start = range ? Math.max(0, Math.floor(range.start)) : 0;
  const end = range
    ? Math.min(buf.sampleCount, Math.ceil(range.end))
    : buf.sampleCount;
  if (end <= start) return { annotations, packets };

  const transitions = range
    ? windowTransitions(buf, start, end)
    : buf.transitions();
  state.samplenum = start;
  const gen = decoder.decode(ctx);
  let result = gen.next();
  while (!result.done) {
    const conds = normalize(result.value);
    matched.length = conds.length;
    const next = advance(
      buf,
      transitions,
      channelMap,
      conds,
      state.samplenum,
      matched,
      end,
    );
    if (next < 0) break;
    // Every wait must advance the cursor. All bundled decoders do (skipToSample
    // clamps skip to >= 1, and edge/level matches only occur at indices > current),
    // but a { skip: 0 } / negative-skip from a buggy third-party decoder would
    // otherwise spin here forever while put()/emit() grow without bound.
    if (next <= state.samplenum) break;
    state.samplenum = next;
    const pins = pinStateAt(buf, channelMap, next);
    result = gen.next(pins);
  }
  return { annotations, packets };
}

/** Run a stacked decoder over the packets produced by a source decoder. */
export function runStacked(
  decoder: Decoder,
  packets: Packet[],
  options: Record<string, string | number>,
): Annotation[] {
  const annotations: Annotation[] = [];
  if (!decoder.decodeStacked) return annotations;
  const ctx: StackedContext = {
    options,
    put(startSample, endSample, annClass, texts) {
      annotations.push({ startSample, endSample, annClass, texts });
    },
  };
  const inputType = decoder.meta.inputType;
  const relevant = inputType
    ? packets.filter((p) => p.type === inputType)
    : packets;
  decoder.decodeStacked(relevant, ctx);
  return annotations;
}

function normalize(input: WaitInput): WaitCondition[] {
  return Array.isArray(input) ? input : [input];
}

function pinStateAt(
  buf: CaptureBuffer,
  channelMap: ChannelMap,
  index: number,
): PinState {
  return channelMap.map((phys) => bitAt(buf, phys, index));
}
