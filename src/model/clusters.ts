import type { CaptureBuffer } from "./capture";

/** Idle gap (samples) that separates activity clusters — ~1 ms, min 32. */
export function clusterGapFor(sampleRate: number): number {
  return Math.max(Math.round(sampleRate * 0.001), 32);
}

/**
 * Group signal edges into "content" clusters — runs of activity separated by
 * an idle gap of more than `gapSamples`. Returns [start, end] sample ranges.
 */
export function contentClusters(
  buf: CaptureBuffer,
  gapSamples: number,
): Array<[number, number]> {
  const trans = buf.transitions();
  if (trans.length === 0) return [];
  const gap = Math.max(gapSamples, 1);
  const clusters: Array<[number, number]> = [];
  let start = trans[0];
  let end = trans[0];
  for (let i = 1; i < trans.length; i++) {
    if (trans[i] - end > gap) {
      clusters.push([start, end]);
      start = trans[i];
    }
    end = trans[i];
  }
  clusters.push([start, end]);
  return clusters;
}
