// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { get } from "svelte/store";
import {
  captureBuffer,
  captureStatus,
  captureTick,
  monitorActive,
  sampleSource,
} from "./session";
import { monitorLines } from "./monitor";
import {
  registerUnloadGuard,
  unsavedWork,
  unsavedWorkReason,
} from "./unloadGuard";
import { packLevels } from "../test/waveforms";
import { monitorLine } from "../test/fixtures";

const idle = {
  captureStatus: "idle" as const,
  sampleSource: "capture" as const,
  sampleCount: 0,
  monitorActive: false,
  monitorLineCount: 0,
};

describe("unsavedWorkReason", () => {
  it("is silent with nothing captured or logged", () => {
    expect(unsavedWorkReason(idle)).toBeNull();
  });

  it("warns while a capture or the monitor is running", () => {
    expect(unsavedWorkReason({ ...idle, captureStatus: "running" })).toMatch(
      /capture is still running/,
    );
    expect(unsavedWorkReason({ ...idle, monitorActive: true })).toMatch(
      /monitor is still running/,
    );
  });

  it("warns about a finished capture and a serial log", () => {
    expect(
      unsavedWorkReason({
        ...idle,
        captureStatus: "done",
        sampleCount: 1000,
      }),
    ).toMatch(/capture/);
    expect(unsavedWorkReason({ ...idle, monitorLineCount: 3 })).toMatch(
      /serial log/,
    );
  });

  it("stays silent for an imported or demo capture — that data is on disk", () => {
    for (const source of ["import", "demo"] as const) {
      expect(
        unsavedWorkReason({
          ...idle,
          captureStatus: "done",
          sampleSource: source,
          sampleCount: 1000,
        }),
      ).toBeNull();
    }
  });
});

function reset(): void {
  captureStatus.set("idle");
  captureBuffer.set(null);
  sampleSource.set("capture");
  monitorActive.set(false);
  monitorLines.set([]);
}

describe("unsavedWork store", () => {
  beforeEach(reset);

  it("tracks samples arriving mid-capture (buffer fills by mutation)", () => {
    const buf = packLevels(1_000_000, [0, 1, 0, 1]);
    captureBuffer.set(buf);
    captureTick.update((n) => n + 1);
    expect(get(unsavedWork)).not.toBeNull();

    captureBuffer.set(null);
    expect(get(unsavedWork)).toBeNull();
  });
});

describe("registerUnloadGuard", () => {
  let teardown: (() => void) | null = null;

  beforeEach(() => {
    reset();
    teardown = registerUnloadGuard();
  });

  afterEach(() => {
    teardown?.();
    teardown = null;
    reset();
  });

  function fireUnload(): Event {
    const event = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(event);
    return event;
  }

  it("lets an empty session unload without a prompt", () => {
    expect(fireUnload().defaultPrevented).toBe(false);
  });

  it("blocks unload when a capture would be lost", () => {
    captureStatus.set("done");
    captureBuffer.set(packLevels(1_000_000, [0, 1, 0, 1]));
    expect(fireUnload().defaultPrevented).toBe(true);
  });

  it("blocks unload when serial-monitor lines would be lost", () => {
    monitorLines.set([monitorLine("hi")]);
    expect(fireUnload().defaultPrevented).toBe(true);
  });

  it("registers once and stops guarding after teardown", () => {
    const second = registerUnloadGuard();
    captureStatus.set("running");
    expect(fireUnload().defaultPrevented).toBe(true);

    second(); // no-op: the first registration owns the listener
    expect(fireUnload().defaultPrevented).toBe(true);

    teardown?.();
    teardown = null;
    expect(fireUnload().defaultPrevented).toBe(false);
  });
});
