import { describe, expect, it } from "vitest";
import { CaptureBuffer } from "./capture";
import { contentClusters, clusterGapFor } from "./clusters";

describe("CaptureBuffer", () => {
  it("appends across chunks and grows capacity", () => {
    const buf = new CaptureBuffer(1_000_000, 4); // tiny initial capacity forces growth
    buf.append(new Uint8Array([0x01, 0x02, 0x03]));
    buf.append(new Uint8Array([0x04, 0x05]));
    expect(buf.sampleCount).toBe(5);
    expect(buf.byteAt(0)).toBe(0x01);
    expect(buf.byteAt(4)).toBe(0x05);
    expect(buf.baseSample).toBe(0);
  });

  it("reads per-channel bit values", () => {
    const buf = new CaptureBuffer(1_000_000, 8);
    buf.append(new Uint8Array([0b0000_0001, 0b1000_0000]));
    expect(buf.channelValueAt(0, 0)).toBe(1);
    expect(buf.channelValueAt(7, 0)).toBe(0);
    expect(buf.channelValueAt(0, 1)).toBe(0);
    expect(buf.channelValueAt(7, 1)).toBe(1);
  });

  it("computes channel min/max for downsampling", () => {
    const buf = new CaptureBuffer(1_000_000, 8);
    // channel 0: 0,0,1,1 ; channel 1: all 0
    buf.append(new Uint8Array([0b00, 0b00, 0b01, 0b01]));
    expect(buf.channelMinMax(0, 0, 2)).toEqual([0, 0]); // all low
    expect(buf.channelMinMax(0, 2, 4)).toEqual([1, 1]); // all high
    expect(buf.channelMinMax(0, 0, 4)).toEqual([0, 1]); // edge in window
    expect(buf.channelMinMax(1, 0, 4)).toEqual([0, 0]);
  });

  // channelMinMax is backed by a packed AND/OR pyramid; verify it against a
  // brute-force scan across many ranges/channels, spanning enough samples to
  // exercise several pyramid levels and the sub-cell fringes at each end.
  it("channelMinMax matches a brute-force scan (pyramid over many levels)", () => {
    const bruteMinMax = (
      data: Uint8Array,
      ch: number,
      start: number,
      end: number,
    ): [number, number] => {
      let lo = false;
      let hi = false;
      for (let i = start; i < end; i++) {
        if ((data[i] >> ch) & 1) hi = true;
        else lo = true;
      }
      return lo && hi ? [0, 1] : hi ? [1, 1] : [0, 0];
    };

    // Deterministic pseudo-random bytes, longer than one base cell (64) so the
    // pyramid stacks several levels; mostly-idle bits mixed with busy ones.
    const N = 1000;
    const data = new Uint8Array(N);
    let seed = 12345;
    for (let i = 0; i < N; i++) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      // ch0 toggles fast, ch1 rare pulses, ch2 idle-high, others noisy.
      data[i] =
        (i & 1) |
        (seed % 97 === 0 ? 0b10 : 0) |
        0b100 |
        ((seed >> 5) & 0b11111000);
    }

    // Append in irregular chunks so the incremental extend path is exercised.
    const buf = new CaptureBuffer(1_000_000, 8);
    for (let off = 0; off < N; off += 37) {
      buf.append(data.subarray(off, Math.min(off + 37, N)));
    }

    const ranges: [number, number][] = [
      [0, N],
      [0, 1],
      [5, 70],
      [63, 65],
      [64, 128],
      [100, 900],
      [1, 999],
      [200, 201],
      [128, 512],
      [500, 1000],
    ];
    for (let ch = 0; ch < 8; ch++) {
      for (const [s, e] of ranges) {
        expect(buf.channelMinMax(ch, s, e)).toEqual(
          bruteMinMax(data, ch, s, e),
        );
      }
    }
  });

  it("tracks the recent edge interval (median gap) for the follow view", () => {
    const buf = new CaptureBuffer(1_000_000, 8);
    buf.append(new Uint8Array([0, 0])); // no transitions yet
    expect(buf.recentEdgeInterval()).toBeNull();

    // Toggle channel 0 every 10 samples across a couple of chunks -> gaps of 10.
    const chunk = new Uint8Array(500);
    for (let i = 0; i < chunk.length; i++) chunk[i] = Math.floor(i / 10) % 2;
    buf.append(chunk.subarray(0, 250));
    buf.append(chunk.subarray(250));
    expect(buf.recentEdgeInterval()).toBe(10);
  });

  it("tracks activity clusters incrementally, matching contentClusters", () => {
    const rate = 1_000_000; // clusterGap = 1000 samples
    const N = 3300;
    const data = new Uint8Array(N);
    // Two bursts (edges every 10 samples) separated by a long idle gap.
    for (let i = 100; i < 300; i++) data[i] = Math.floor((i - 100) / 10) % 2;
    for (let i = 3000; i < 3200; i++) data[i] = Math.floor((i - 3000) / 10) % 2;

    const buf = new CaptureBuffer(rate, N);
    buf.append(data.subarray(0, 1500)); // split mid-idle to exercise the boundary
    buf.append(data.subarray(1500));

    const full = contentClusters(buf, clusterGapFor(rate));
    expect(full.length).toBe(2);
    expect(buf.activityClusterCount()).toBe(full.length);
    expect(buf.latestCluster()).toEqual(full[full.length - 1]);
  });

  it("has no activity cluster until an edge appears", () => {
    const buf = new CaptureBuffer(1_000_000, 16);
    buf.append(new Uint8Array(10)); // all idle
    expect(buf.activityClusterCount()).toBe(0);
    expect(buf.latestCluster()).toBeNull();
  });

  it("builds and caches the transition index, invalidating on append", () => {
    const buf = new CaptureBuffer(1_000_000, 16);
    buf.append(new Uint8Array([0, 0, 1, 1, 0])); // edges at index 2 and 4
    expect(Array.from(buf.transitions())).toEqual([2, 4]);
    const first = buf.transitions();
    expect(buf.transitions()).toBe(first); // cached (same reference)
    buf.append(new Uint8Array([1])); // edge at index 5
    expect(Array.from(buf.transitions())).toEqual([2, 4, 5]);
  });

  it("trims old samples and advances baseSample", () => {
    const buf = new CaptureBuffer(1_000_000, 16);
    buf.append(new Uint8Array([10, 20, 30, 40, 50]));
    buf.trimBefore(2);
    expect(buf.sampleCount).toBe(3);
    expect(buf.baseSample).toBe(2);
    expect(buf.byteAt(0)).toBe(30);
    expect(buf.byteAt(2)).toBe(50);
    // transition cache is rebuilt against the trimmed data (edges 30->40, 40->50)
    expect(Array.from(buf.transitions())).toEqual([1, 2]);
    buf.append(new Uint8Array([50])); // 50==50 -> no new edge
    expect(Array.from(buf.transitions())).toEqual([1, 2]);
  });

  it("channelMinMax stays correct after a trim rebuilds the summary", () => {
    const buf = new CaptureBuffer(1_000_000, 16);
    buf.append(new Uint8Array([0b0, 0b0, 0b1, 0b1, 0b0])); // ch0: 0,0,1,1,0
    expect(buf.channelMinMax(0, 0, 5)).toEqual([0, 1]);
    buf.trimBefore(2); // now ch0: 1,1,0
    expect(buf.channelMinMax(0, 0, 2)).toEqual([1, 1]); // the two highs
    expect(buf.channelMinMax(0, 0, 3)).toEqual([0, 1]); // includes the trailing low
  });

  it("trimBefore clamps and ignores non-positive input", () => {
    const buf = new CaptureBuffer(1_000_000, 8);
    buf.append(new Uint8Array([1, 2, 3]));
    buf.trimBefore(0);
    expect(buf.sampleCount).toBe(3);
    buf.trimBefore(99); // clamp to length
    expect(buf.sampleCount).toBe(0);
    expect(buf.baseSample).toBe(3);
  });
});
