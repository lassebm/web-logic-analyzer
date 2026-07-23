import { get, writable, derived } from "svelte/store";
import { Fx2Device } from "../usb/fx2Device";
import {
  needsFirmware,
  uploadFirmware,
  waitForReenumeration,
} from "../usb/firmware";
import { loadFirmware, type StoredFirmware } from "../usb/firmwareStore";
import { loadBundledFirmware } from "../firmware";
import { CaptureSession, getFirmwareVersion, getRevId } from "../usb/capture";
import { CaptureBuffer } from "../model/capture";
import { findTrigger, type TriggerSpec } from "../model/trigger";
import { NUM_CHANNELS, PRE_FIRMWARE_DEVICES } from "../usb/constants";
import { formatSampleRate } from "../usb/sampleRate";
import { runDecoder, runStacked } from "../decode/engine";
import { getDecoder } from "../decode/registry";
import { scanChannels, type Detection } from "../decode/detect";
import { buildDemoCapture, DEMO_DECODERS } from "../demo/capture";
import type { Annotation, Packet } from "../decode/types";
import type { WaveView } from "../view/renderer";

export type ConnStatus =
  | "disconnected"
  | "connecting"
  | "need-firmware"
  | "reselect"
  | "ready"
  | "error";
export type CaptureStatus = "idle" | "running" | "done" | "error";

export interface CaptureConfigState {
  sampleRate: number;
  sampleLimit: number;
  enabledChannels: boolean[];
  trigger: TriggerSpec;
}

export interface DecoderInstance {
  uid: string;
  decoderId: string;
  /** User-facing name, editable; distinguishes multiple instances of one type. */
  label: string;
  /** logical channel -> physical capture channel */
  channelMap: number[];
  options: Record<string, string | number>;
  annotations: Annotation[];
  /** For stacked decoders: uid of the source instance whose packets to consume. */
  stackOnUid?: string;
  /** Whether this decoder runs at all (live and on stop); default true. */
  enabled?: boolean;
}

// --- Stores ---
export const connStatus = writable<ConnStatus>("disconnected");
export const statusMessage = writable<string>("");
export const deviceLabel = writable<string>("");
export const firmwareInfo = writable<StoredFirmware | null>(null);
export const fwUploadProgress = writable<number>(0); // 0..1

export const config = writable<CaptureConfigState>({
  sampleRate: 1_000_000,
  sampleLimit: 1_000_000,
  enabledChannels: Array(NUM_CHANNELS).fill(true),
  trigger: { conditions: [] },
});

export const captureStatus = writable<CaptureStatus>("idle");
export const captureBuffer = writable<CaptureBuffer | null>(null);
export const captureTick = writable<number>(0); // bumped as samples stream in
export const captureSamples = writable<number>(0); // live count of collected samples
export const triggerSample = writable<number | null>(null);

/** Where the current on-screen buffer came from. Distinguishes a real capture
 *  (measured against the configured sample limit — the source of the progress
 *  percentage) from a loaded buffer, where a "% of limit" is meaningless. */
export type SampleSource = "capture" | "import" | "demo";
export const sampleSource = writable<SampleSource>("capture");

export const view = writable<WaveView>({ viewStart: 0, samplesPerPixel: 1 });
export const cursors = writable<number[]>([]);
export const decoders = writable<DecoderInstance[]>([]);
export const viewportWidth = writable<number>(800); // waveform canvas width in px

/**
 * True while the view is showing the whole capture (fit). Set when we fit —
 * on load/finalize (fitAndDecode) or the Fit button (zoomToFit) — and cleared by
 * any manual zoom/pan/jump. navigation re-runs the fit when the viewport width
 * changes while this holds, so a fit computed against a stale width (e.g. the
 * demo fits before its tab's canvas has been laid out) self-corrects instead of
 * leaving blank space until the user clicks Fit.
 */
export const viewFitsWhole = writable<boolean>(false);

// Master enable for decoding; each DecoderInstance can also be toggled on/off
// individually (enabled). A decoder only runs — live while capturing AND in the
// full decode on stop — when both the master and its own flag are on. Off leaves
// no annotations, so you can focus on a subset of decoders.
export const decodersEnabled = writable<boolean>(true);

// Result of the last "Detect" scan: channels that look like UART, with recovered
// baud/framing. Empty array = scan ran and found nothing; null = not scanned yet.
export const detections = writable<Detection[] | null>(null);

let device: Fx2Device | null = null;
let session: CaptureSession | null = null;
let uidCounter = 0;

/** The connected device, or null. Used by the serial monitor (stores/monitor.ts). */
export function connectedDevice(): Fx2Device | null {
  return device;
}

// --- Firmware ---
export async function refreshFirmware(): Promise<void> {
  firmwareInfo.set(await loadFirmware());
}

// --- Connection ---
export async function connect(): Promise<void> {
  if (!Fx2Device.isSupported()) {
    connStatus.set("error");
    statusMessage.set(
      "WebUSB is not available. Use Chrome, Edge, or another Chromium browser.",
    );
    return;
  }
  try {
    connStatus.set("connecting");
    statusMessage.set("Requesting device…");
    const dev = await Fx2Device.request();
    await provision(dev);
  } catch (err) {
    connStatus.set("error");
    statusMessage.set(friendlyError(err));
  }
}

/**
 * Complete setup after a firmware upload whose re-enumerated device could not
 * reconnect automatically (its running-fx2lafw identity was never granted to
 * this origin — see provision()). Must run from a user gesture: prompts the
 * standard device chooser, where the just-re-enumerated device now appears.
 * Selecting it grants (and persists) that identity, so later reconnects are
 * silent. Uses the full filters — a running device doesn't reliably present a
 * POST_FIRMWARE_DEVICES VID:PID, so a narrowed chooser can come up empty.
 * A cancelled chooser drops back to "reselect" so the user can retry, rather
 * than the dead-end "error" state.
 */
export async function finishConnect(): Promise<void> {
  try {
    connStatus.set("connecting");
    statusMessage.set("Requesting device…");
    const dev = await Fx2Device.request();
    await provision(dev);
  } catch (err) {
    if (isNoDeviceSelected(err)) {
      connStatus.set("reselect");
      statusMessage.set(
        "No device picked. Click “Finish connecting” and select the device from the list.",
      );
      return;
    }
    connStatus.set("error");
    statusMessage.set(friendlyError(err));
  }
}

/** Try to reconnect to an already-authorized, ready device without a prompt. */
export async function tryReconnect(): Promise<void> {
  const authorized = await Fx2Device.getAuthorized();
  const ready = authorized.find((d) => !needsFirmware(d));
  if (ready) {
    try {
      await provision(ready);
    } catch {
      /* ignore silent reconnect failures */
    }
  }
}

async function provision(dev: Fx2Device): Promise<void> {
  await dev.open();

  if (needsFirmware(dev)) {
    const match = PRE_FIRMWARE_DEVICES.find(
      (d) => d.vendorId === dev.vendorId && d.productId === dev.productId,
    );

    // Prefer a user-supplied custom firmware; otherwise use the bundled image
    // that matches this device's VID:PID.
    const custom = get(firmwareInfo) ?? (await loadFirmware());
    let image: ArrayBuffer | null = custom?.data ?? null;
    let source = custom ? `custom (${custom.name})` : "";
    if (!image && match) {
      image = await loadBundledFirmware(match.firmware);
      if (image) source = `bundled ${match.firmware}`;
    }

    if (!image) {
      const idHex = `${hex4(dev.vendorId)}:${hex4(dev.productId)}`;
      const hint = match
        ? ` For this device (${idHex}, ${match.name}) use ${match.firmware}.`
        : "";
      connStatus.set("need-firmware");
      statusMessage.set(
        `This device needs fx2lafw firmware, and no bundled match was found.${hint} Download it (link in the top bar), load the .fw, then Connect again.`,
      );
      await dev.close();
      return;
    }

    statusMessage.set(`Uploading firmware — ${source}…`);
    fwUploadProgress.set(0);
    await uploadFirmware(dev, image, (done, total) =>
      fwUploadProgress.set(done / total),
    );
    await dev.close();

    // Wait for the device to come back under its running-fx2lafw identity. This
    // succeeds automatically only if this origin already holds permission for
    // that identity (repeat connects in a normal window). On the first connect —
    // and every incognito session — the re-enumerated device's VID:PID was never
    // granted, so getDevices() can't surface it and this times out: we then ask
    // for one confirming pick via finishConnect() rather than dead-ending.
    statusMessage.set("Waiting for device to re-enumerate…");
    const reenum = await waitForReenumeration();
    if (!reenum) {
      connStatus.set("reselect");
      statusMessage.set(
        "Firmware uploaded. Click “Finish connecting” and pick the device from the list.",
      );
      return;
    }
    device = reenum;
  } else {
    device = dev;
  }

  await device.claim();
  const ver = await getFirmwareVersion(device);
  let revid = -1;
  try {
    revid = await getRevId(device);
  } catch {
    /* optional */
  }
  connStatus.set("ready");
  deviceLabel.set(
    `${device.productName ?? "fx2lafw"} — fw ${ver.major}.${ver.minor}${revid >= 0 ? `, rev ${revid}` : ""}`,
  );
  statusMessage.set("Ready");
}

export async function disconnect(): Promise<void> {
  session?.stop();
  if (device) {
    await device.release();
    await device.close();
    device = null;
  }
  connStatus.set("disconnected");
  deviceLabel.set("");
  statusMessage.set("");
}

/**
 * React to the physical device being unplugged. WebUSB fires `disconnect` on
 * `navigator.usb`; we can't release/close a device that's already gone, so we
 * just drop our references and reset status. Ignores unrelated devices.
 */
function onUsbDisconnect(event: { device?: USBDevice }): void {
  if (!device || event.device !== device.device) return;
  session?.stop();
  session = null;
  device = null;
  connStatus.set("disconnected");
  deviceLabel.set("");
  statusMessage.set("Device disconnected. Replug it and Connect again.");
}

let disconnectTarget: USB | null = null;

/**
 * Register the `navigator.usb` disconnect listener so unplugging the device is
 * reflected in the UI. Called from the device bar on mount. Idempotent per
 * `navigator.usb` object (re-registers only if it is swapped, e.g. in tests).
 */
export function watchUsbDisconnect(): void {
  const usb = navigator.usb;
  if (!usb || typeof usb.addEventListener !== "function") return;
  if (disconnectTarget === usb) return;
  disconnectTarget = usb;
  usb.addEventListener("disconnect", onUsbDisconnect as EventListener);
}

// --- Capture ---
export async function startCapture(): Promise<void> {
  if (!device || get(monitorActive)) return;
  const cfg = get(config);
  const buf = new CaptureBuffer(
    cfg.sampleRate,
    Math.min(cfg.sampleLimit, 1 << 24),
  );
  captureBuffer.set(buf);
  sampleSource.set("capture");
  triggerSample.set(null);
  captureSamples.set(0);
  // Drop the previous capture's decoded annotations so stale results don't show.
  decoders.update((list) => list.map((d) => ({ ...d, annotations: [] })));
  detections.set(null); // previous scan no longer applies to the new capture
  captureStatus.set("running");
  statusMessage.set("Capturing…");

  session = new CaptureSession(
    device,
    { sampleRate: cfg.sampleRate, sampleLimit: cfg.sampleLimit },
    {
      onData: (chunk) => {
        buf.append(chunk);
        captureTick.update((n) => n + 1);
      },
      onProgress: (n) => captureSamples.set(n),
      onError: (err) => {
        captureStatus.set("error");
        statusMessage.set(friendlyError(err));
      },
    },
  );

  await session.run();
  session = null;

  // A mid-capture unplug nulls `device` (see onUsbDisconnect). Keep the partial
  // capture, but let the disconnect message stand rather than "Captured N".
  const deviceLost = device === null;
  if (get(captureStatus) === "running") captureStatus.set("done");
  finalizeCapture(buf, cfg);
  if (deviceLost)
    statusMessage.set("Device disconnected — showing the partial capture.");
}

export function stopCapture(): void {
  session?.stop();
}

function finalizeCapture(buf: CaptureBuffer, cfg: CaptureConfigState): void {
  const trig = findTrigger(buf, cfg.trigger);
  triggerSample.set(trig >= 0 ? trig : null);
  fitAndDecode(buf, `Captured ${buf.sampleCount.toLocaleString()} samples.`);
}

/**
 * Fit the whole buffer into the actual viewport width (measured by the canvas
 * ResizeObserver) and decode it. Falls back to a 1000 px guess only before the
 * canvas has been laid out; `viewFitsWhole` then re-fits once the real measured
 * width arrives, so wide displays don't stay under-filled.
 */
function fitAndDecode(buf: CaptureBuffer, status: string): void {
  const w = get(viewportWidth) || 1000;
  const spp = Math.max(buf.sampleCount / w, 1 / 32);
  view.set({ viewStart: 0, samplesPerPixel: spp });
  viewFitsWhole.set(true); // re-fit if the real width arrives after this (see store)
  captureTick.update((n) => n + 1);
  statusMessage.set(status);
  runAllDecoders();
}

/**
 * Load an imported capture buffer as if it had just been captured: swaps it in,
 * syncs the sample rate, clears stale decode/detection, and fits + decodes.
 * Returns false without loading while the Serial Monitor owns the device
 * (capture ↔ monitor are mutually exclusive).
 */
export function loadCapture(
  buf: CaptureBuffer,
  source: SampleSource = "import",
): boolean {
  if (get(monitorActive)) return false;
  captureBuffer.set(buf);
  sampleSource.set(source);
  captureSamples.set(buf.sampleCount);
  triggerSample.set(null);
  decoders.update((list) => list.map((d) => ({ ...d, annotations: [] })));
  detections.set(null);
  config.update((c) => ({ ...c, sampleRate: buf.sampleRate }));
  captureStatus.set("done");
  fitAndDecode(buf, `Imported ${buf.sampleCount.toLocaleString()} samples.`);
  return true;
}

/**
 * Load the built-in demo capture (all supported protocols) and add a decoder for
 * each, pre-wired to the demo's channel map — so the app can be explored with no
 * hardware. Replaces any current decoders. Returns false while the Serial
 * Monitor owns the device.
 */
export function loadDemo(): boolean {
  if (get(monitorActive)) return false;
  decoders.set([]);
  if (!loadCapture(buildDemoCapture(), "demo")) return false;
  for (const d of DEMO_DECODERS)
    addDecoder(d.decoderId, { channelMap: d.channelMap, options: d.options });
  statusMessage.set("Loaded demo capture — all supported protocols.");
  return true;
}

// --- Decoders ---
export function addDecoder(
  decoderId: string,
  overrides?: {
    channelMap?: number[];
    options?: Record<string, string | number>;
  },
): void {
  const dec = getDecoder(decoderId);
  if (!dec) return;
  const options: Record<string, string | number> = {};
  for (const o of dec.meta.options) options[o.id] = o.default;
  if (overrides?.options) Object.assign(options, overrides.options);
  const channelMap =
    overrides?.channelMap ?? dec.meta.channels.map((_, i) => i); // default D0..Dn

  // Auto-number so multiple instances of one type are distinguishable (e.g. two
  // UARTs for RX/TX); the user can rename freely afterwards.
  const n = get(decoders).filter((i) => i.decoderId === decoderId).length + 1;
  const label = `${dec.meta.name} ${n}`;

  // For a stacked decoder, default its source to the first compatible instance.
  let stackOnUid: string | undefined;
  if (dec.meta.inputType) {
    const src = get(decoders).find((inst) => {
      const d = getDecoder(inst.decoderId);
      return d?.meta.outputType === dec.meta.inputType;
    });
    stackOnUid = src?.uid;
  }

  decoders.update((list) => [
    ...list,
    {
      uid: `dec${uidCounter++}`,
      decoderId,
      label,
      channelMap,
      options,
      annotations: [],
      stackOnUid,
      enabled: true,
    },
  ]);
  runAllDecoders();
}

export function removeDecoder(uid: string): void {
  decoders.update((list) => list.filter((d) => d.uid !== uid));
}

/**
 * Reorder a decoder to a new index (drag-to-move in the panel). Order only
 * affects the top-to-bottom position and hue of the annotation lanes — stacking
 * resolves by `stackOnUid` regardless of position — so this is a pure reorder
 * with no re-decode needed; each instance keeps its existing annotations.
 */
export function moveDecoder(uid: string, toIndex: number): void {
  decoders.update((list) => {
    const from = list.findIndex((d) => d.uid === uid);
    if (from === -1) return list;
    const clamped = Math.max(0, Math.min(toIndex, list.length - 1));
    if (clamped === from) return list;
    const next = [...list];
    const [moved] = next.splice(from, 1);
    next.splice(clamped, 0, moved);
    return next;
  });
}

/** Enable/disable a single decoder (both live and on stop), refreshing results. */
export function setDecoderEnabled(uid: string, on: boolean): void {
  decoders.update((list) =>
    list.map((d) =>
      d.uid === uid
        ? { ...d, enabled: on, annotations: on ? d.annotations : [] }
        : d,
    ),
  );
  refreshDecoders();
}

/** Enable/disable all decoders at once (master switch). */
export function setAllDecodersEnabled(on: boolean): void {
  decodersEnabled.set(on);
  // Turning the master off clears every lane immediately; turning it on lets the
  // refresh (or the next live pass) re-decode the individually-enabled ones.
  if (!on)
    decoders.update((list) => list.map((d) => ({ ...d, annotations: [] })));
  refreshDecoders();
}

// Re-run decoders after an enable/disable. While capturing we skip the full
// (O(n)) decode — the live in-view pass refreshes the enabled decoders and each
// toggle already clears a disabled decoder's lane on its own.
function refreshDecoders(): void {
  if (get(captureStatus) !== "running") runAllDecoders();
}

export function updateDecoder(
  uid: string,
  patch: Partial<DecoderInstance>,
): void {
  decoders.update((list) =>
    list.map((d) => (d.uid === uid ? { ...d, ...patch } : d)),
  );
  runAllDecoders();
}

/**
 * Run every configured decoder and store the resulting annotations. With no
 * argument it decodes the whole capture (used on finalize and on add/edit). Pass
 * a sample `range` to decode only that window — the live, in-view pass driven by
 * the follow view during a capture, so cost is bounded by what's on screen.
 */
export function runAllDecoders(range?: { start: number; end: number }): void {
  const buf = get(captureBuffer);
  if (!buf || buf.sampleCount === 0) return;
  const list = get(decoders);
  const packetsByUid = new Map<string, Packet[]>();
  // A decoder runs only when the master switch and its own flag are both on;
  // disabled decoders are cleared (no annotations, no packets for stacking).
  const masterOn = get(decodersEnabled);
  const active = (inst: DecoderInstance) => masterOn && inst.enabled !== false;

  // Pass 1: logic decoders (produce annotations + packets).
  const afterLogic = list.map((inst) => {
    const dec = getDecoder(inst.decoderId);
    if (!dec || !dec.decode) return inst;
    if (!active(inst)) return { ...inst, annotations: [] };
    try {
      const { annotations, packets } = runDecoder(
        dec,
        buf,
        inst.channelMap,
        inst.options,
        range,
      );
      packetsByUid.set(inst.uid, packets);
      return { ...inst, annotations };
    } catch (err) {
      console.error("decoder failed", err);
      return { ...inst, annotations: [] };
    }
  });

  // Pass 2: stacked decoders (consume a source instance's packets).
  const final = afterLogic.map((inst) => {
    const dec = getDecoder(inst.decoderId);
    if (!dec || !dec.decodeStacked) return inst;
    if (!active(inst)) return { ...inst, annotations: [] };
    const src = inst.stackOnUid
      ? (packetsByUid.get(inst.stackOnUid) ?? [])
      : [];
    try {
      const annotations = runStacked(dec, src, inst.options);
      return { ...inst, annotations };
    } catch (err) {
      console.error("stacked decoder failed", err);
      return { ...inst, annotations: [] };
    }
  });

  decoders.set(final);
}

// --- Detection ---
/**
 * Scan the enabled channels of the current capture for supported protocols and
 * store the results (one entry per detected signal). Reads the rate from the
 * buffer to match the decode engine. No-op (clears results) when there is no
 * capture.
 */
export function runDetection(): void {
  const buf = get(captureBuffer);
  if (!buf || buf.sampleCount === 0) {
    detections.set(null);
    return;
  }
  const enabled = get(config).enabledChannels;
  const channels = enabled
    .map((on, ch) => (on ? ch : -1))
    .filter((ch) => ch >= 0);
  detections.set(scanChannels(buf, channels));
}

/**
 * Warn when the sample rate is too low to decode a configured UART/CAN decoder
 * (needs roughly >= 4x the baud/bit rate). Null when every decoder is fine.
 */
export const decoderRateWarning = derived(
  [decoders, config],
  ([$decoders, $config]) => {
    for (const inst of $decoders) {
      const rate = Number(inst.options.baudrate ?? inst.options.bitrate ?? 0);
      if (rate > 0 && $config.sampleRate < rate * 4) {
        return `Sample rate ${formatSampleRate($config.sampleRate)} is too low for the ${inst.label} decoder at ${rate.toLocaleString()} baud — use at least 4× the baud rate (${formatSampleRate(rate * 4)}+).`;
      }
    }
    return null;
  },
);

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function hex4(n: number): string {
  return "0x" + n.toString(16).padStart(4, "0");
}

/** A cancelled/empty device chooser (user closed it without picking). */
function isNoDeviceSelected(err: unknown): boolean {
  const m = errMsg(err).toLowerCase();
  return m.includes("no device selected") || m.includes("user gesture");
}

/** Translate common WebUSB errors into guidance a user can act on. */
export function friendlyError(err: unknown): string {
  const raw = errMsg(err);
  const m = raw.toLowerCase();
  if (
    m.includes("unable to set device configuration") ||
    m.includes("unable to claim") ||
    m.includes("access denied") ||
    m.includes("access was denied")
  ) {
    return "Could not open the device — it looks like another tab, browser, or program is using it (e.g. PulseView, sigrok, or other browser). Close anything else using it, unplug and replug the device, then Connect again.";
  }
  if (m.includes("no device selected") || m.includes("user gesture")) {
    return "No device was selected.";
  }
  if (
    m.includes("disconnected") ||
    m.includes("no such device") ||
    m.includes("device unavailable")
  ) {
    return "The device disconnected. Replug it and Connect again.";
  }
  if (m.includes("transfer") && m.includes("stall")) {
    return "The device stalled. Unplug and replug it, then Connect again.";
  }
  return raw;
}

// Top-level UI tab, and the serial-monitor active flag. The flag lives here (not
// in stores/monitor.ts) because startCapture reads it for mutual exclusion; the
// monitor module imports and re-exports it. This keeps the dependency one-way.
export type Tab = "analyzer" | "monitor";
export const activeTab = writable<Tab>("analyzer");
export const monitorActive = writable<boolean>(false);
