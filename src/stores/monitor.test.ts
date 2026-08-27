import { beforeEach, describe, expect, it, vi } from "vitest";
import { get } from "svelte/store";

// The monitor drives a real acquisition against connectedDevice(); the fake USB
// device below streams one UART burst and then stays pending, so run() stays
// alive until stopMonitor() aborts it (as it does in the app). It is wrapped in
// the real Fx2LogicDevice so the monitor sees genuine capabilities.
import { Fx2LogicDevice } from "../device/fx2";
import type { Fx2Device } from "../usb/fx2Device";
import type { LogicDevice } from "../device/types";

let pendingRejects: Array<(e: unknown) => void> = [];
let queued: Uint8Array[] = [];

const fakeFx2 = {
  async claim() {},
  async controlOut() {},
  readBulk(): Promise<USBInTransferResult> {
    const next = queued.shift();
    if (next) {
      return Promise.resolve({
        status: "ok",
        data: new DataView(next.buffer),
      } as USBInTransferResult);
    }
    // Several transfers stay in flight; reset() must reject them all or
    // run()'s allSettled never settles.
    return new Promise((_res, rej) => {
      pendingRejects.push(rej);
    });
  },
  async reset() {
    while (pendingRejects.length) pendingRejects.pop()?.(new Error("aborted"));
  },
} as unknown as Fx2Device;

const fx2Device = new Fx2LogicDevice(fakeFx2, "fake fx2");

/** A one-shot device: dumps a buffer, so it cannot stream continuously. */
const oneShotDevice: LogicDevice = {
  label: "one-shot",
  capabilities: {
    ...fx2Device.capabilities,
    streaming: false,
    continuous: false,
  },
  resolveSampleRate: (hz) => hz,
  acquire: () => ({
    run: () => Promise.reject(new Error("should never be acquired")),
    stop: () => {},
  }),
  close: async () => {},
};

let currentDevice: LogicDevice = fx2Device;

vi.mock("./session", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./session")>();
  return { ...actual, connectedDevice: () => currentDevice };
});

const { monitorActive, captureStatus } = await import("./session");
const {
  startMonitor,
  stopMonitor,
  monitorLines,
  monitorConfig,
  pickMonitorRate,
} = await import("./monitor");

/** UART bytes at `baud` sampled at `rate`, on channel 0, 8-N-1 LSB-first. */
function uartStream(text: string, rate: number, baud: number): Uint8Array {
  const spb = Math.round(rate / baud);
  const out: number[] = [];
  const push = (v: number, n: number) => {
    for (let i = 0; i < n; i++) out.push(v);
  };
  push(1, spb * 4); // idle
  for (const ch of text) {
    push(0, spb); // start bit
    for (let i = 0; i < 8; i++) push((ch.charCodeAt(0) >> i) & 1, spb);
    push(1, spb * 2); // stop + idle
  }
  push(1, spb * 8);
  return new Uint8Array(out);
}

beforeEach(() => {
  queued = [];
  pendingRejects = [];
  currentDevice = fx2Device;
  captureStatus.set("idle");
  monitorActive.set(false);
  monitorLines.set([]);
});

describe("serial monitor orchestration", () => {
  it("decodes streamed bytes once, and stopping releases the exclusion flag", async () => {
    const cfg = get(monitorConfig);
    const rate = pickMonitorRate(cfg.baud);
    queued = [uartStream("Hi\n", rate, cfg.baud)]; // newline flushes the line

    const running = startMonitor();
    await vi.waitFor(() => expect(get(monitorActive)).toBe(true));

    // The 80 ms poll decodes what has arrived; each byte must appear exactly
    // once no matter how many times the tick runs over the same buffer. Two
    // mechanisms enforce that (the lastProcessedAbs guard and the trim after
    // each pass); removing either alone still passes, both gives "HiHiHi".
    await vi.waitFor(
      () => {
        const text = get(monitorLines)
          .map((l) => l.text)
          .join("");
        expect(text).toContain("Hi");
      },
      { timeout: 2000 },
    );
    const first = get(monitorLines)
      .map((l) => l.text)
      .join("");
    await new Promise((r) => setTimeout(r, 200)); // several more ticks
    expect(
      get(monitorLines)
        .map((l) => l.text)
        .join(""),
    ).toBe(first);
    expect(first.match(/H/g)).toHaveLength(1);

    stopMonitor();
    await running;
    expect(get(monitorActive)).toBe(false);
  });

  // publishLines() shares closed lines (so the view can key its formatting cache
  // on them) but copies the open one (so its row re-renders as it grows).
  it("shares closed lines across publishes and copies the open one", async () => {
    const cfg = get(monitorConfig);
    const rate = pickMonitorRate(cfg.baud);
    queued = [uartStream("Hi\nX", rate, cfg.baud)]; // "Hi" closes, "X" stays open

    const running = startMonitor();
    await vi.waitFor(() => expect(get(monitorLines)).toHaveLength(2), {
      timeout: 2000,
    });
    const [closedBefore, openBefore] = get(monitorLines);

    stopMonitor(); // publishes again
    await running;
    const [closedAfter, openAfter] = get(monitorLines);

    expect(closedAfter).toBe(closedBefore);
    expect(openAfter).not.toBe(openBefore);
    expect(openAfter.id).toBe(openBefore.id); // still the same logical line
  });

  // The monitor is an endless capture; a device that fills its own memory once
  // and dumps it can't do that, and must be refused rather than left hanging on
  // a one-shot acquisition. SerialMonitor.svelte says why in the UI.
  it("refuses to start on a device that cannot capture continuously", async () => {
    currentDevice = oneShotDevice;
    await startMonitor();
    expect(get(monitorActive)).toBe(false);
    expect(get(monitorLines)).toHaveLength(0);
  });

  it("picks a monitor rate from the device's own rate list", () => {
    // 115200 baud wants ~921600 Hz; from this list the first rate at or above
    // it is 1 MHz, not the FX2 table's value.
    expect(pickMonitorRate(115200, [100_000, 1_000_000, 50_000_000])).toBe(
      1_000_000,
    );
    // Nothing fast enough: fall back to the fastest the device has.
    expect(pickMonitorRate(921600, [100_000, 200_000])).toBe(200_000);
  });
});
