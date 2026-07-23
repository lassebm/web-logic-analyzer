/**
 * Holds captured logic samples as packed bytes (1 byte = 8 channels, bit N =
 * channel N) in a growable Uint8Array. Provides per-channel bit access and an
 * edge iterator used by both the renderer and the decoder engine.
 */
import { clusterGapFor } from "./clusters";

export class CaptureBuffer {
  readonly sampleRate: number;
  private data: Uint8Array;
  private length = 0;
  private _transitions: Uint32Array | null = null;
  private _transitionsLen = -1;
  private base = 0;

  // Downsampling summary: a packed AND/OR min-max pyramid over the samples.
  // channelMinMax uses it so a zoomed-out pixel column (which can span thousands
  // of samples) resolves in O(log n) instead of scanning every sample it covers.
  // Level 0 holds one cell per SUM_BASE samples: the bitwise AND (bits that are
  // always high => per-channel min) and OR (bits ever high => per-channel max)
  // of that block's bytes. Each higher level pairwise-reduces the one below.
  // Extended incrementally as samples append; rebuilt from scratch after a trim.
  private static readonly SUM_LOG = 6; // 64 samples per base cell
  private sumLen = 0; // samples reflected in the pyramid
  private levAnd: Uint8Array[] = [];
  private levOr: Uint8Array[] = [];
  private levN: number[] = []; // valid cell count per level

  // Recent-edge tracker for the live "follow" view's adaptive zoom: a ring of the
  // most recent transition sample indices, filled incrementally on append (O(chunk)).
  // Lets followView size the window to the signal's current edge rate without
  // scanning the whole buffer. Reset on trim, since the indices shift.
  private static readonly EDGE_RING = 256;
  private edgeRing = new Int32Array(CaptureBuffer.EDGE_RING);
  private edgeCount = 0; // total edges ever recorded (indexes the ring modulo size)

  // Live activity-cluster tracking, maintained incrementally on append so the UI
  // can show the region count grow during a capture and the follow view can frame
  // the latest activity — without the O(n) rescan contentClusters would need per
  // chunk. Mirrors contentClusters exactly: a new cluster starts when an edge is
  // more than clusterGap samples after the previous one.
  private readonly clusterGap: number;
  private lastEdgePos = -1;
  private clusterCount = 0;
  private curStart = 0; // extent of the most recent cluster
  private curEnd = 0;

  constructor(sampleRate: number, capacityHint = 1 << 20) {
    this.sampleRate = sampleRate;
    this.data = new Uint8Array(Math.max(capacityHint, 1024));
    this.clusterGap = clusterGapFor(sampleRate);
  }

  get sampleCount(): number {
    return this.length;
  }

  /**
   * Absolute index of local sample 0. Grows as old samples are trimmed
   * (see trimBefore), so absolute time of local index i is
   * (baseSample + i) / sampleRate. Used by the continuous serial monitor.
   */
  get baseSample(): number {
    return this.base;
  }

  /** Append raw device bytes (one packed byte per sample). */
  append(chunk: Uint8Array): void {
    const from = this.length;
    this.ensureCapacity(this.length + chunk.length);
    this.data.set(chunk, this.length);
    this.length += chunk.length;
    this.recordEdges(from);
  }

  /**
   * Record transition positions in [from, length) into the recent-edge ring and
   * update the live activity-cluster tally.
   */
  private recordEdges(from: number): void {
    const K = CaptureBuffer.EDGE_RING;
    const data = this.data;
    const gap = this.clusterGap;
    for (let i = Math.max(1, from); i < this.length; i++) {
      if (data[i] !== data[i - 1]) {
        this.edgeRing[this.edgeCount % K] = i;
        this.edgeCount++;
        if (this.lastEdgePos < 0 || i - this.lastEdgePos > gap) {
          this.clusterCount++; // an idle gap ended -> a new activity cluster
          this.curStart = i;
        }
        this.curEnd = i;
        this.lastEdgePos = i;
      }
    }
  }

  /** Number of activity clusters seen so far (live; matches contentClusters). */
  activityClusterCount(): number {
    return this.clusterCount;
  }

  /** Extent [start, end] of the most recent activity cluster, or null if none. */
  latestCluster(): [number, number] | null {
    return this.clusterCount > 0 ? [this.curStart, this.curEnd] : null;
  }

  /**
   * Median spacing (in samples) between the most recent transitions, or null if
   * fewer than two have been seen. The median ignores the odd long idle gap, so
   * it reflects the signal's active timescale — used to pick the follow zoom.
   */
  recentEdgeInterval(): number | null {
    const K = CaptureBuffer.EDGE_RING;
    const n = Math.min(this.edgeCount, K);
    if (n < 2) return null;
    const start = this.edgeCount - n;
    const gaps: number[] = [];
    let prev = this.edgeRing[start % K];
    for (let j = 1; j < n; j++) {
      const pos = this.edgeRing[(start + j) % K];
      gaps.push(pos - prev);
      prev = pos;
    }
    gaps.sort((a, b) => a - b);
    const mid = gaps.length >> 1;
    return gaps.length % 2 ? gaps[mid] : (gaps[mid - 1] + gaps[mid]) / 2;
  }

  /**
   * Drop the first `localIndex` samples, shifting the rest to the front and
   * advancing baseSample. Keeps memory bounded during continuous acquisition
   * while preserving absolute sample numbering. Invalidates the edge cache.
   */
  trimBefore(localIndex: number): void {
    const n = Math.max(0, Math.min(localIndex, this.length));
    if (n === 0) return;
    this.data.copyWithin(0, n, this.length);
    this.length -= n;
    this.base += n;
    this._transitionsLen = -1;
    this.sumLen = 0; // samples shifted -> the summary must be rebuilt
    // Edge/cluster indices shifted -> drop the incremental activity history.
    this.edgeCount = 0;
    this.lastEdgePos = -1;
    this.clusterCount = 0;
    this.curStart = 0;
    this.curEnd = 0;
  }

  /** Raw packed byte at sample index. */
  byteAt(index: number): number {
    return this.data[index];
  }

  /** Value (0/1) of a channel at a sample index. */
  channelValueAt(channel: number, index: number): 0 | 1 {
    return ((this.data[index] >> channel) & 1) as 0 | 1;
  }

  /**
   * Sorted sample indices at which the packed byte changes (any channel edge).
   * Cached and rebuilt when the sample count changes. Used by the decoder
   * engine to jump between edges instead of scanning every sample.
   */
  transitions(): Uint32Array {
    if (this._transitions && this._transitionsLen === this.length)
      return this._transitions;
    const idx: number[] = [];
    for (let i = 1; i < this.length; i++) {
      if (this.data[i] !== this.data[i - 1]) idx.push(i);
    }
    this._transitions = Uint32Array.from(idx);
    this._transitionsLen = this.length;
    return this._transitions;
  }

  /**
   * Min/max of a channel over [start, end) as a pair suitable for downsampled
   * rendering: returns [min, max] where each is 0 or 1. If any sample is high
   * and any is low, returns [0, 1] (an edge occurred in the window).
   */
  channelMinMax(channel: number, start: number, end: number): [0 | 1, 0 | 1] {
    const hi = Math.min(end, this.length);
    const lo = Math.max(0, start);
    if (lo >= hi) return [0, 0];
    this.ensureSummary();
    const packed = this.rangeAndOr(lo, hi);
    const andBit = (packed >> (8 + channel)) & 1;
    const orBit = (packed >> channel) & 1;
    return andBit === orBit ? [andBit as 0 | 1, andBit as 0 | 1] : [0, 1];
  }

  /**
   * Bitwise AND and OR of the packed bytes over [start, end), as `(and << 8) | or`.
   * Whole base-cell spans are folded through the pyramid in O(log n); only the
   * sub-cell fringes at each end are read from raw samples. Callers must have
   * called ensureSummary() and pass 0 <= start < end <= length.
   */
  private rangeAndOr(start: number, end: number): number {
    const LOG = CaptureBuffer.SUM_LOG;
    const BASE = 1 << LOG;
    const data = this.data;
    let a = 0xff;
    let o = 0;

    // Head fringe: raw samples up to the first whole base-cell boundary.
    const headEnd = Math.min(end, ((start + BASE - 1) >> LOG) << LOG);
    for (let i = start; i < headEnd; i++) {
      a &= data[i];
      o |= data[i];
    }
    if (headEnd >= end) return (a << 8) | o;

    // Tail fringe: raw samples after the last whole base-cell boundary.
    const tailStart = (end >> LOG) << LOG;
    for (let i = tailStart; i < end; i++) {
      a &= data[i];
      o |= data[i];
    }

    // Middle: whole base cells [l, r), reduced bottom-up through the pyramid.
    let l = headEnd >> LOG;
    let r = tailStart >> LOG;
    let level = 0;
    while (l < r) {
      const la = this.levAnd[level];
      const lo = this.levOr[level];
      if (l & 1) {
        a &= la[l];
        o |= lo[l];
        l++;
      }
      if (r & 1) {
        r--;
        a &= la[r];
        o |= lo[r];
      }
      l >>= 1;
      r >>= 1;
      level++;
    }
    return (a << 8) | o;
  }

  /** Bring the pyramid up to date with the current samples (cheap when already so). */
  private ensureSummary(): void {
    const n = this.length;
    if (this.sumLen === n && this.levAnd.length > 0) return;
    if (n === 0) {
      this.sumLen = 0;
      this.levAnd = [];
      this.levOr = [];
      this.levN = [];
      return;
    }
    if (n < this.sumLen) this.sumLen = 0; // shrunk (trim) -> rebuild from scratch
    this.extendBase(n);
    this.rebuildUpperLevels();
    this.sumLen = n;
  }

  /** (Re)compute level-0 cells for samples in [sumLen, n), growing the arrays. */
  private extendBase(n: number): void {
    const LOG = CaptureBuffer.SUM_LOG;
    const BASE = 1 << LOG;
    const need = (n + BASE - 1) >> LOG;

    if (this.levAnd.length === 0) {
      this.levAnd = [new Uint8Array(Math.max(need, 1))];
      this.levOr = [new Uint8Array(Math.max(need, 1))];
      this.levN = [0];
    } else if (this.levAnd[0].length < need) {
      let cap = this.levAnd[0].length;
      while (cap < need) cap *= 2;
      const a = new Uint8Array(cap);
      a.set(this.levAnd[0]);
      this.levAnd[0] = a;
      const o = new Uint8Array(cap);
      o.set(this.levOr[0]);
      this.levOr[0] = o;
    }

    const a0 = this.levAnd[0];
    const o0 = this.levOr[0];
    const data = this.data;
    // Recompute from the cell that held the previous (partial) end onward.
    const from = this.sumLen === 0 ? 0 : this.sumLen >> LOG;
    for (let b = from; b < need; b++) {
      let a = 0xff;
      let o = 0;
      const s0 = b << LOG;
      const s1 = Math.min(s0 + BASE, n);
      for (let i = s0; i < s1; i++) {
        a &= data[i];
        o |= data[i];
      }
      a0[b] = a;
      o0[b] = o;
    }
    this.levN[0] = need;
  }

  /** Rebuild levels 1.. by pairwise-reducing the level below (O(cells)). */
  private rebuildUpperLevels(): void {
    let k = 0;
    while (this.levN[k] > 1) {
      const childN = this.levN[k];
      const parentN = (childN + 1) >> 1;
      if (this.levAnd.length <= k + 1) {
        this.levAnd.push(new Uint8Array(Math.max(parentN, 1)));
        this.levOr.push(new Uint8Array(Math.max(parentN, 1)));
        this.levN.push(0);
      } else if (this.levAnd[k + 1].length < parentN) {
        let cap = this.levAnd[k + 1].length;
        while (cap < parentN) cap *= 2;
        this.levAnd[k + 1] = new Uint8Array(cap);
        this.levOr[k + 1] = new Uint8Array(cap);
      }
      const ca = this.levAnd[k];
      const co = this.levOr[k];
      const pa = this.levAnd[k + 1];
      const po = this.levOr[k + 1];
      for (let j = 0; j < parentN; j++) {
        const c0 = 2 * j;
        const c1 = c0 + 1;
        let a = ca[c0];
        let o = co[c0];
        if (c1 < childN) {
          a &= ca[c1];
          o |= co[c1];
        }
        pa[j] = a;
        po[j] = o;
      }
      this.levN[k + 1] = parentN;
      k++;
    }
    // Drop stale higher levels left over from a previously larger buffer.
    this.levAnd.length = k + 1;
    this.levOr.length = k + 1;
    this.levN.length = k + 1;
  }

  private ensureCapacity(needed: number): void {
    if (needed <= this.data.length) return;
    let cap = this.data.length;
    while (cap < needed) cap *= 2;
    const grown = new Uint8Array(cap);
    grown.set(this.data.subarray(0, this.length));
    this.data = grown;
  }
}
