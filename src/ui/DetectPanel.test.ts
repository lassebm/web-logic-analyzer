// @vitest-environment jsdom
import { render, screen, fireEvent } from "@testing-library/svelte";
import { get } from "svelte/store";
import { tick } from "svelte";
import { beforeEach, describe, expect, it } from "vitest";
import DetectPanel from "./DetectPanel.svelte";
import { detections, decoders } from "../stores/session";
import type { I2cDetection, UartDetection } from "../decode/detect";

const HIT: UartDetection = {
  kind: "uart",
  channels: [0],
  baudrate: 115200,
  data_bits: 8,
  parity: "none",
  invert: "no",
  frameCount: 7,
  confidence: 0.98,
};

const I2C_HIT: I2cDetection = {
  kind: "i2c",
  channels: [0, 1],
  byteCount: 12,
  confidence: 0.94,
};

beforeEach(() => {
  detections.set(null);
  decoders.set([]);
});

describe("DetectPanel", () => {
  it("renders nothing before a scan has run", () => {
    const { container } = render(DetectPanel);
    expect(container.querySelector("section")).toBeNull();
  });

  it("shows a protocol-neutral empty state when a scan found nothing", async () => {
    detections.set([]);
    render(DetectPanel);
    await tick();
    expect(
      screen.getByText(/No supported signals detected/i),
    ).toBeInTheDocument();
  });

  it("renders a hit as 'UART on D0' with baud, frame format and confidence", async () => {
    detections.set([HIT]);
    render(DetectPanel);
    await tick();
    expect(screen.getByText("on")).toBeInTheDocument(); // "UART on D0"
    expect(screen.getByText("D0")).toBeInTheDocument();
    expect(screen.getByText(/115,200 baud .* 8-N-1/)).toBeInTheDocument();
    expect(screen.getByText(/98% match/)).toBeInTheDocument();
  });

  it("marks an inverted line", async () => {
    detections.set([{ ...HIT, invert: "yes" }]);
    render(DetectPanel);
    await tick();
    expect(screen.getByText("inverted")).toBeInTheDocument();
  });

  it("renders an I²C hit as 'I²C on SCL D0 · SDA D1' with byte count", async () => {
    detections.set([I2C_HIT]);
    render(DetectPanel);
    await tick();
    expect(screen.getByText("I²C", { selector: ".proto" })).toBeInTheDocument();
    expect(screen.getByText("SCL D0 · SDA D1")).toBeInTheDocument();
    expect(screen.getByText(/12 bytes/)).toBeInTheDocument();
    expect(screen.getByText(/94% match/)).toBeInTheDocument();
  });

  it("Add decoder creates a UART decoder pre-configured from the detection", async () => {
    detections.set([{ ...HIT, channels: [2], baudrate: 9600, parity: "even" }]);
    render(DetectPanel);
    await fireEvent.click(screen.getByRole("button", { name: "Add decoder" }));
    const inst = get(decoders)[0];
    expect(inst.decoderId).toBe("uart");
    expect(inst.channelMap).toEqual([2]);
    expect(inst.options.baudrate).toBe(9600);
    expect(inst.options.parity).toBe("even");
  });

  it("Add decoder creates an I²C decoder wired [SCL, SDA] from the detection", async () => {
    detections.set([{ ...I2C_HIT, channels: [3, 5] }]);
    render(DetectPanel);
    await fireEvent.click(screen.getByRole("button", { name: "Add decoder" }));
    const inst = get(decoders)[0];
    expect(inst.decoderId).toBe("i2c");
    expect(inst.channelMap).toEqual([3, 5]);
  });

  it("dismiss clears the results", async () => {
    detections.set([HIT]);
    render(DetectPanel);
    await fireEvent.click(
      screen.getByRole("button", { name: "Dismiss detection results" }),
    );
    expect(get(detections)).toBeNull();
  });

  it("documents what the detector supports (info popover content in the DOM)", async () => {
    detections.set([]);
    render(DetectPanel);
    await tick();
    expect(screen.getByText(/Currently supported/i)).toBeInTheDocument();
  });
});
