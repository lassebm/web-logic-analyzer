// @vitest-environment jsdom
import { render, screen } from "@testing-library/svelte";
import { beforeEach, describe, expect, it } from "vitest";
import Measurements from "./Measurements.svelte";
import { captureBuffer, cursors } from "../stores/session";
import { CaptureBuffer } from "../model/capture";

beforeEach(() => {
  captureBuffer.set(null);
  cursors.set([]);
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
