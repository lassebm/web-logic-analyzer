// Continuous UART serial-monitor orchestration. Streams from the connected
// device, decodes one UART line live, and assembles terminal lines (the pure
// line-assembly logic lives in monitor/terminal.ts).
//
// The connection and the capture/monitor mutual-exclusion flags are owned by
// session.ts; this module imports them (one-way) so it stays free of a cycle.
import { get, writable } from "svelte/store";
import { CaptureBuffer } from "../model/capture";
import { CaptureSession } from "../usb/capture";
import { SerialTerminal, type MonitorLine } from "../monitor/terminal";
import { getDecoder } from "../decode/registry";
import { runDecoder } from "../decode/engine";
import type { BytePacket } from "../decode/types";
import { SAMPLE_RATES } from "../usb/sampleRate";
import {
  connectedDevice,
  friendlyError,
  captureStatus,
  statusMessage,
  monitorActive,
} from "./session";

// Re-exported so consumers get all monitor state from one module even though
// the active flag is declared in session (capture reads it too).
export { monitorActive };

export interface MonitorConfig {
  channel: number;
  baud: number;
  dataBits: number;
  parity: string; // none | odd | even
  stopBits: number;
  bitOrder: string; // lsb-first | msb-first
  invert: string; // no | yes
  /** Whether to start a new line after an idle gap (vs. only on line-feed). */
  newlineOnIdle: boolean;
  /** Idle gap (ms) after which a new line is started. */
  gapMs: number;
  // Display columns (independently toggleable).
  showText: boolean;
  showHex: boolean;
  tsWall: boolean; // wall-clock time of day
  tsFromStart: boolean; // seconds since monitor start
  tsSinceLast: boolean; // seconds since previous line
}

export const monitorLines = writable<MonitorLine[]>([]);
export const monitorStartEpoch = writable<number>(0); // ms epoch at monitor start
export const monitorConfig = writable<MonitorConfig>({
  channel: 0,
  baud: 115200,
  dataBits: 8,
  parity: "none",
  stopBits: 1,
  bitOrder: "lsb-first",
  invert: "no",
  newlineOnIdle: true,
  gapMs: 50,
  showText: true,
  showHex: false,
  tsWall: false,
  tsFromStart: true,
  tsSinceLast: false,
});

let monitorBuf: CaptureBuffer | null = null;
let monitorSession: CaptureSession | null = null;
let monitorTimer: ReturnType<typeof setInterval> | null = null;
let terminal: SerialTerminal | null = null;
let lastProcessedAbs = -1;

/** Pick a supported sample rate that oversamples the baud rate ~8x. */
export function pickMonitorRate(baud: number): number {
  // The baud field is an editable dropdown, so it can be momentarily empty/invalid;
  // fall back to the default so the rate readout and capture stay sensible.
  const target = (baud > 0 ? baud : 115200) * 8;
  return (
    SAMPLE_RATES.find((r) => r >= target) ??
    SAMPLE_RATES[SAMPLE_RATES.length - 1]
  );
}

function processMonitor(): void {
  if (!monitorBuf || !terminal) return;
  const cfg = get(monitorConfig);
  const uart = getDecoder("uart");
  if (!uart) return;

  const spb = monitorBuf.sampleRate / cfg.baud;
  const { packets } = runDecoder(uart, monitorBuf, [cfg.channel], {
    baudrate: cfg.baud,
    data_bits: cfg.dataBits,
    parity: cfg.parity,
    stop_bits: cfg.stopBits,
    bit_order: cfg.bitOrder,
    invert: cfg.invert,
  });

  let lastEndLocal = -1;
  for (const p of packets) {
    const absStart = monitorBuf.baseSample + p.startSample;
    if (absStart <= lastProcessedAbs) continue;
    lastProcessedAbs = absStart;
    lastEndLocal = p.endSample;
    terminal.feed(
      Number((p.data as BytePacket).value),
      absStart / monitorBuf.sampleRate,
    );
  }

  // Bound memory by trimming to the END of the last fully-decoded byte. That
  // sample sits in the stop-bit/idle region, so the next decode always starts
  // at a real frame boundary — trimming mid-frame would otherwise make the
  // decoder mistake a data edge for a start bit and emit a spurious byte.
  if (lastEndLocal >= 0) {
    monitorBuf.trimBefore(lastEndLocal);
  } else if (monitorBuf.sampleCount > 2_000_000) {
    monitorBuf.trimBefore(monitorBuf.sampleCount - Math.ceil(spb * 20));
  }

  monitorLines.set(terminal.lines.slice());
}

export async function startMonitor(): Promise<void> {
  const device = connectedDevice();
  if (!device || get(monitorActive) || get(captureStatus) === "running") return;
  const cfg = get(monitorConfig);
  const rate = pickMonitorRate(cfg.baud);

  monitorBuf = new CaptureBuffer(rate, 1 << 20);
  terminal = new SerialTerminal(
    cfg.newlineOnIdle ? cfg.gapMs : Number.POSITIVE_INFINITY,
  );
  lastProcessedAbs = -1;
  monitorLines.set([]);
  monitorStartEpoch.set(Date.now());
  monitorActive.set(true);
  statusMessage.set(
    `Serial monitor @ ${cfg.baud} baud (sampling ${rate / 1e6} MHz)…`,
  );

  monitorTimer = setInterval(processMonitor, 80);

  monitorSession = new CaptureSession(
    device,
    {
      sampleRate: rate,
      sampleLimit: Number.MAX_SAFE_INTEGER,
      transferSize: 8 * 1024,
    },
    {
      onData: (chunk) => monitorBuf?.append(chunk),
      onError: (err) => statusMessage.set(friendlyError(err)),
    },
  );

  await monitorSession.run(); // resolves when stopMonitor() stops it
  monitorSession = null;
}

export function stopMonitor(): void {
  monitorSession?.stop();
  if (monitorTimer) {
    clearInterval(monitorTimer);
    monitorTimer = null;
  }
  processMonitor(); // flush any decoded tail
  monitorActive.set(false);
  statusMessage.set("Serial monitor stopped.");
}

function applyGap(): void {
  const c = get(monitorConfig);
  terminal?.setGap(c.newlineOnIdle ? c.gapMs : Number.POSITIVE_INFINITY);
}

/** Live-update the gap threshold without restarting the monitor. */
export function setMonitorGap(ms: number): void {
  monitorConfig.update((c) => ({ ...c, gapMs: ms }));
  applyGap();
}

/** Toggle idle-based line breaking live. */
export function setNewlineOnIdle(on: boolean): void {
  monitorConfig.update((c) => ({ ...c, newlineOnIdle: on }));
  applyGap();
}

export function clearMonitor(): void {
  terminal?.clear();
  monitorLines.set([]);
}
