// The hardware-agnostic seam. Everything above it — CaptureBuffer, the decode
// engine, detection, the renderer, import/export — already consumes nothing but
// packed samples plus a rate; this is the contract the backends implement so
// stores/session.ts never names a concrete device.

import type { TriggerSpec } from "../model/trigger";

/** Backends we ship. Persisted in localStorage, so don't rename lightly. */
export type BackendId = "fx2" | "sump";

/** What a connected device can do. Drives the capture toolbar and the gating of
 *  features (Follow, Serial Monitor) that not every device can support. */
export interface DeviceCapabilities {
  /** Channels this device actually has, ≤ NUM_CHANNELS. Drives the channel chips. */
  channels: number;
  /** Selectable rates (Hz, ascending) — already resolved to what the device will do. */
  sampleRates: number[];
  /** Selectable sample counts, clamped to the device's memory. */
  sampleLimits: number[];
  /** The device itself waits for the trigger condition. */
  hardwareTrigger: boolean;
  /** Samples arrive progressively (FX2) vs. one buffered dump (SUMP). */
  streaming: boolean;
  /** Endless capture is possible — what the Serial Monitor needs. */
  continuous: boolean;
}

export interface AcquisitionRequest {
  sampleRate: number;
  sampleLimit: number;
  trigger: TriggerSpec;
  /** Serial monitor: small, low-latency reads. */
  transferSize?: number;
}

export interface CaptureCallbacks {
  onData: (chunk: Uint8Array) => void;
  onProgress?: (samplesCollected: number) => void;
  onError?: (err: unknown) => void;
  /** The device caught the trigger itself, at this sample of the capture. It
   *  wins over searching the data, where the condition need not show (see
   *  `sump/device.ts`); a backend that leaves triggering to software never
   *  calls it. */
  onTrigger?: (sample: number) => void;
}

export interface Acquisition {
  /** Resolves on completion. Never rejects — failures arrive via `onError`, so
   *  the caller's happy path stays linear (see stores/session.startCapture). */
  run(): Promise<void>;
  stop(): void;
}

export interface LogicDevice {
  /** Shown in the device bar. */
  readonly label: string;
  readonly capabilities: DeviceCapabilities;
  /** The rate the device will really use for a requested one (divider rounding). */
  resolveSampleRate(hz: number): number;
  acquire(req: AcquisitionRequest, cb: CaptureCallbacks): Acquisition;
  close(): Promise<void>;
}

/**
 * How a connect attempt ended. `reselect` and `need-firmware` exist because a
 * connect can legitimately stop half-way and need one more user action with an
 * explanation (the FX2 firmware-upload flow); they map onto the `ConnStatus`
 * states the device bar renders. A cancelled chooser throws instead — see
 * `isNoDeviceSelected` in stores/session.ts.
 */
export type ConnectResult =
  | { kind: "device"; device: LogicDevice }
  | { kind: "none" } // nothing found, or nothing to do
  | { kind: "reselect"; message: string }
  | { kind: "need-firmware"; message: string };

/** Lets a backend report progress without importing the session's stores. */
export interface ConnectContext {
  status(message: string): void;
  /** 0..1 firmware upload progress; only the FX2 backend calls it. */
  progress?(fraction: number): void;
}

export interface DeviceBackend {
  readonly id: BackendId;
  /** Shown in the device-bar backend selector, e.g. "FX2 (USB)". */
  readonly name: string;
  /** What the toolbar offers before anything is connected. */
  readonly defaultCapabilities: DeviceCapabilities;
  isSupported(): boolean;
  /** Why not, when `isSupported()` is false. */
  readonly unsupportedMessage: string;
  /** Prompts the browser's device chooser; requires a user gesture. */
  connect(ctx: ConnectContext): Promise<ConnectResult>;
  /** Silent, on page load — only already-authorized devices. */
  reconnect(ctx: ConnectContext): Promise<ConnectResult>;
  /** Called once on mount; fires when a device this backend handed out is lost. */
  watchDisconnect(onLost: (dev: LogicDevice) => void): void;
}
