import { describe, expect, it } from "vitest";
import { CaptureBuffer } from "./capture";
import { clusterGapFor, contentClusters } from "./clusters";

describe("contentClusters", () => {
  it("returns nothing for a flat signal", () => {
    const b = new CaptureBuffer(1_000_000, 8);
    b.append(new Uint8Array([0, 0, 0, 0]));
    expect(contentClusters(b, 10)).toEqual([]);
  });

  it("groups nearby edges and splits on large gaps", () => {
    const b = new CaptureBuffer(1_000_000, 64);
    const levels = new Uint8Array(50);
    // burst A: toggles around 2..5, burst B: toggles around 40..43
    levels[2] = 1;
    levels[4] = 0; // edges at 2,3,4,5 region
    levels[3] = 1;
    levels[5] = 1;
    levels[40] = 1;
    levels[41] = 0;
    levels[42] = 1;
    b.append(levels);
    const clusters = contentClusters(b, 10); // gap 10 splits the two bursts
    expect(clusters.length).toBe(2);
    expect(clusters[0][0]).toBeLessThanOrEqual(5);
    expect(clusters[1][0]).toBeGreaterThanOrEqual(40);
  });

  it("clusterGapFor scales with sample rate but has a floor", () => {
    expect(clusterGapFor(1_000_000)).toBe(1000); // ~1 ms
    expect(clusterGapFor(1_000)).toBe(32); // floor
  });
});
