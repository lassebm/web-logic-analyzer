// @vitest-environment jsdom
import { render, screen } from "@testing-library/svelte";
import { beforeEach, describe, expect, it } from "vitest";
import Measurements from "./Measurements.svelte";
import { captureBuffer, cursors, triggerSample } from "../stores/session";
import { CaptureBuffer } from "../model/capture";

beforeEach(() => {
  captureBuffer.set(null);
  cursors.set([]);
  triggerSample.set(null);
});

describe("Measurements", () => {
  it("prompts to drop cursors when none are set", () => {
    render(Measurements);
    expect(screen.getByText(/click the waveform/i)).toBeInTheDocument();
  });

  it("shows Δt and frequency between two cursors", () => {
    const buf = new CaptureBuffer(1_000_000, 8);
    buf.append(new Uint8Array(2000));
    captureBuffer.set(buf);
    cursors.set([0, 1000]); // 1000 samples @ 1 MHz = 1 ms -> 1 kHz
    render(Measurements);
    expect(screen.getByText(/Δt: 1\.000 ms/)).toBeInTheDocument();
    expect(screen.getByText(/1\.0000 kHz/)).toBeInTheDocument();
    expect(screen.getByText(/1,000/)).toBeInTheDocument(); // Δ samples
  });
});
describe("Measurements time base", () => {
  // The canvas ruler is trigger-relative and its gutter says "Time (from
  // trigger)", but the cursor readout used absolute sample times, so the same x
  // reported two different times.
  it("reports cursor times relative to the trigger", () => {
    const buf = new CaptureBuffer(1_000_000, 8);
    buf.append(new Uint8Array(8));
    captureBuffer.set(buf);
    triggerSample.set(100);
    cursors.set([100, 150]);

    render(Measurements);
    // Sample 100 is the trigger, so C1 reads 0 and C2 reads +50 µs.
    const tags = screen.getAllByText(/^C\d:/).map((el) => el.textContent);
    expect(tags[0]).toMatch(/C1: 0\.0 ns/);
    expect(tags[1]).toMatch(/C2: 50\.000 µs/);
  });
});
