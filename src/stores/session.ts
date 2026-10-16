import { get, writable, derived } from "svelte/store";
import { firmwareInfo, refreshFirmware } from "../usb/firmwareState";
import { CaptureBuffer } from "../model/capture";
import { findTrigger, type TriggerSpec } from "../model/trigger";
import { NUM_CHANNELS } from "../device/channels";
import {
  BACKENDS,
  DEFAULT_BACKEND_ID,
  getBackend,
  isBackendId,
} from "../device/registry";
import type {
  Acquisition,
  BackendId,
  ConnectContext,
  ConnectResult,
  DeviceBackend,
  DeviceCapabilities,
  LogicDevice,
} from "../device/types";
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
  /** How many captures one Run takes. `CAPTURES_UNTIL_STOPPED` = keep going. */
  captures: number;
}

/**
 * Repeat until the user stops (or the trigger fires). Zero rather than Infinity
 * so the value survives a structured clone and reads as a plain option value.
 */
export const CAPTURES_UNTIL_STOPPED = 0;

/** Selectable capture counts, in the order the toolbar lists them. */
export const CAPTURE_COUNTS = [1, 2, 5, 10, 25, 50, CAPTURES_UNTIL_STOPPED];

/**
 * One finished capture in a repeat run. Each is an ordinary `CaptureBuffer`, so
 * paging to it is just swapping `captureBuffer` — the renderer, decoders,
 * measurements, detection and export all keep working with no notion of
 * captures at all.
 */
export interface CaptureRecord {
  buffer: CaptureBuffer;
  /** ms after the run started that this capture completed. */
  atMs: number;
  /** Sample the trigger matched at, or null if it never did. */
  trigger: number | null;
}

/**
 * Total samples held across retained captures before the oldest are dropped.
 * "Until stopped" is otherwise unbounded; this is one FX2 max-length capture's
 * worth, so a single deep capture always fits.
 */
const MAX_RETAINED_SAMPLES = 100_000_000;

/**
 * Captures retained regardless of size. The sample budget alone doesn't bound
 * an "until stopped" run of very short captures, and the list is copied on every
 * one — so without a count cap a long run degrades quadratically.
 */
const MAX_RETAINED_CAPTURES = 200;

/**
 * Largest capture decoded as it lands, mid-run. The capture is on screen, so
 * empty decoder lanes under a drawn waveform look half-rendered — and with
 * "until stopped" the decoded bytes are how you decide to stop. Bounded because
 * the same loop serves the FX2, where a capture can be 100M samples and
 * decoding each would dominate the run; those wait for the pager to select
 * them. Matches the live in-view decode's budget (MAX_LIVE_DECODE_SAMPLES).
 */
const MAX_LANDED_DECODE_SAMPLES = 2_000_000;

/**
 * Drop the oldest captures until the run fits both budgets. The newest are the
 * ones worth keeping: with a trigger set the run ends on the interesting one,
 * and without one you are watching the live view for what just happened.
 */
export function trimRetained(
  records: CaptureRecord[],
  maxSamples = MAX_RETAINED_SAMPLES,
  maxCount = MAX_RETAINED_CAPTURES,
): CaptureRecord[] {
  let total = records.reduce((n, r) => n + r.buffer.sampleCount, 0);
  let from = 0;
  while (
    records.length - from > 1 &&
    (total > maxSamples || records.length - from > maxCount)
  ) {
    total -= records[from].buffer.sampleCount;
    from++;
  }
  return from === 0 ? records : records.slice(from);
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
export const fwUploadProgress = writable<number>(0); // 0..1

// Owned by usb/firmwareState.ts (device/fx2.ts reads it during a connect, and
// this module imports the backend registry) — re-exported so the UI still gets
// all its session state from here.
export { firmwareInfo, refreshFirmware };

/** Which hardware family Connect talks to. Remembered across sessions, because
 *  a given user almost always has the same device on the bench. */
const BACKEND_STORAGE_KEY = "wla.backend";

function storedBackendId(): BackendId {
  try {
    const saved = localStorage.getItem(BACKEND_STORAGE_KEY);
    if (isBackendId(saved)) return saved;
  } catch {
    /* storage blocked (private mode, or no DOM at all) */
  }
  return DEFAULT_BACKEND_ID;
}

export const backendId = writable<BackendId>(storedBackendId());

/**
 * What the connected device can do — or, while disconnected, what the selected
 * backend offers. Never null, so the toolbar has a rate/sample-count list to
 * render before anything is plugged in.
 */
export const capabilities = writable<DeviceCapabilities>(
  getBackend(get(backendId)).defaultCapabilities,
);

export const config = writable<CaptureConfigState>({
  sampleRate: 1_000_000,
  sampleLimit: 1_000_000,
  enabledChannels: Array(NUM_CHANNELS).fill(true),
  trigger: { conditions: [] },
  captures: 1,
});

// The literal above is written for the FX2 defaults, but the remembered backend
// may be another one — so bring it into range right away rather than waiting for
// a connect. Without this, a page that opens in SUMP mode renders an empty
// sample-count <select>: nothing in [1024, 4096] matches a 1,000,000 limit.
applyCapabilities(get(capabilities));

export const captureStatus = writable<CaptureStatus>("idle");
/**
 * True for the whole of a Run, captures-back-to-back included.
 *
 * Gates the actions that work on a finished capture — Detect, Import, Export.
 * Each of them is O(capture) work on the main thread, and the main thread is
 * what keeps the FX2's transfer queue fed: block it and the FIFO overflows, the
 * stream never comes back, and the stall watchdog ends the run (see AGENTS.md).
 * Import is worse than slow — it would swap the buffer the run is filling.
 */
export const captureRunning = derived(
  captureStatus,
  ($status) => $status === "running",
);
export const captureBuffer = writable<CaptureBuffer | null>(null);
export const captureTick = writable<number>(0); // bumped as samples stream in
export const captureSamples = writable<number>(0); // live count of collected samples
export const triggerSample = writable<number | null>(null);

/** Captures from the last run, oldest first. One entry for a plain single Run. */
export const captures = writable<CaptureRecord[]>([]);
/** 1-based index of the displayed capture; 0 when there are none. */
export const captureCursor = writable<number>(0);

/** The pager readout, or null when there is nothing to page through. */
export const capturePosition = derived(
  [captures, captureCursor],
  ([$captures, $cursor]) =>
    $captures.length > 1
      ? {
          index: $cursor,
          total: $captures.length,
          /** How many of the run's captures met the trigger condition. */
          triggered: $captures.filter((c) => c.trigger !== null).length,
          /** Whether the one on screen did. */
          currentTriggered: $captures[$cursor - 1]?.trigger != null,
        }
      : null,
);

/** Where the current on-screen buffer came from. Distinguishes a real capture
 *  (measured against the configured sample limit — the source of the progress
 *  percentage) from a loaded buffer, where a "% of limit" is meaningless. */
export type SampleSource = "capture" | "import" | "demo";
export const sampleSource = writable<SampleSource>("capture");

/**
 * True for a buffer that exists only in this tab, i.e. one worth asking about
 * before it is discarded. An import can be re-imported and the demo is one click
 * away, so neither counts — the shared rule behind the Run button's confirm step
 * and the beforeunload guard (stores/unloadGuard.ts).
 */
export function isTabOnlyCapture(
  source: SampleSource,
  sampleCount: number,
): boolean {
  return source === "capture" && sampleCount > 0;
}

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

/**
 * Samples a Run is holding, across *every* capture it took — not just the one on
 * screen. A run that was stopped can leave the newest capture short or empty
 * while earlier ones hold real data, so counting only the displayed buffer would
 * report nothing to lose. `captureTick` is a dependency because buffers fill by
 * mutation rather than by being re-set.
 */
export const capturedSamples = derived(
  [captureTick, captureBuffer, captures],
  ([, $buffer, $captures]) =>
    $captures.length > 0
      ? $captures.reduce((n, r) => n + r.buffer.sampleCount, 0)
      : ($buffer?.sampleCount ?? 0),
);

/** What starting a capture would overwrite; drives the Run button's confirm step. */
export const unsavedCapture = derived(
  [capturedSamples, sampleSource],
  ([$samples, $source]) => isTabOnlyCapture($source, $samples),
);

// Master enable for decoding; each DecoderInstance can also be toggled on/off
// individually (enabled). A decoder only runs — live while capturing AND in the
// full decode on stop — when both the master and its own flag are on. Off leaves
// no annotations, so you can focus on a subset of decoders.
export const decodersEnabled = writable<boolean>(true);

// Result of the last "Detect" scan: channels that look like UART, with recovered
// baud/framing. Empty array = scan ran and found nothing; null = not scanned yet.
export const detections = writable<Detection[] | null>(null);

let device: LogicDevice | null = null;
let session: Acquisition | null = null;
let uidCounter = 0;

/** The connected device, or null. Used by the serial monitor (stores/monitor.ts). */
export function connectedDevice(): LogicDevice | null {
  return device;
}

function currentBackend(): DeviceBackend {
  return getBackend(get(backendId));
}

/**
 * Switch hardware family. Refused while connected — the selector is disabled
 * then, and the guard keeps a stale `device` from outliving its backend.
 */
export function setBackend(id: BackendId): void {
  if (device || get(backendId) === id) return;
  backendId.set(id);
  try {
    localStorage.setItem(BACKEND_STORAGE_KEY, id);
  } catch {
    /* storage blocked */
  }
  applyCapabilities(getBackend(id).defaultCapabilities);
  connStatus.set("disconnected");
  statusMessage.set("");
}

// --- Connection ---

/** Lets a backend report progress without reaching into these stores itself. */
function connectContext(): ConnectContext {
  return {
    status: (message) => statusMessage.set(message),
    progress: (fraction) => fwUploadProgress.set(fraction),
  };
}

/**
 * Publish a capability set and bring the config into range for it. Without the
 * clamp, switching to a device with a different rate/sample-count list leaves
 * those `<select>`s showing nothing (no option matches the held value), and a
 * trigger could still name a channel the device doesn't have.
 */
function applyCapabilities(caps: DeviceCapabilities): void {
  capabilities.set(caps);
  config.update((cfg) => ({
    ...cfg,
    sampleRate: nearestOption(caps.sampleRates, cfg.sampleRate),
    sampleLimit: nearestOption(caps.sampleLimits, cfg.sampleLimit),
    // A device change resets the channel selection to "everything this device
    // has", rather than carrying over hiding that was about other hardware.
    enabledChannels: Array.from(
      { length: NUM_CHANNELS },
      (_, ch) => ch < caps.channels,
    ),
    trigger: {
      conditions: cfg.trigger.conditions.filter(
        (c) => c.channel < caps.channels,
      ),
    },
  }));
}

/** The largest offered value at or below `value`, else the smallest offered. */
function nearestOption(options: number[], value: number): number {
  if (options.length === 0 || options.includes(value)) return value;
  const below = options.filter((o) => o <= value);
  return below.length > 0 ? Math.max(...below) : Math.min(...options);
}

function adopt(dev: LogicDevice): void {
  device = dev;
  applyCapabilities(dev.capabilities);
  connStatus.set("ready");
  deviceLabel.set(dev.label);
  statusMessage.set("Ready");
}

/** Map a backend's connect outcome onto the connection status the bar renders. */
function applyResult(result: ConnectResult): void {
  switch (result.kind) {
    case "device":
      adopt(result.device);
      break;
    case "reselect":
      connStatus.set("reselect");
      statusMessage.set(result.message);
      break;
    case "need-firmware":
      connStatus.set("need-firmware");
      statusMessage.set(result.message);
      break;
    case "none":
      break;
  }
}

export async function connect(): Promise<void> {
  const backend = currentBackend();
  if (!backend.isSupported()) {
    connStatus.set("error");
    statusMessage.set(backend.unsupportedMessage);
    return;
  }
  try {
    connStatus.set("connecting");
    applyResult(await backend.connect(connectContext()));
  } catch (err) {
    connStatus.set("error");
    statusMessage.set(friendlyError(err));
  }
}

/**
 * Complete setup after a firmware upload whose re-enumerated device could not
 * reconnect automatically (its running-fx2lafw identity was never granted to
 * this origin). Must run from a user gesture: prompts the standard device
 * chooser, where the just-re-enumerated device now appears. Selecting it grants
 * (and persists) that identity, so later reconnects are silent. A cancelled
 * chooser drops back to "reselect" so the user can retry, rather than the
 * dead-end "error" state.
 */
export async function finishConnect(): Promise<void> {
  try {
    connStatus.set("connecting");
    applyResult(await currentBackend().connect(connectContext()));
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
  const backend = currentBackend();
  if (!backend.isSupported()) return;
  try {
    applyResult(await backend.reconnect(connectContext()));
  } catch {
    /* ignore silent reconnect failures */
  }
}

export async function disconnect(): Promise<void> {
  session?.stop();
  session = null;
  if (device) {
    const dev = device;
    device = null; // drop the reference first, so a close() failure still frees it
    await dev.close();
  }
  connStatus.set("disconnected");
  deviceLabel.set("");
  statusMessage.set("");
}

/**
 * React to the device physically going away (WebUSB `disconnect`, or Web
 * Serial's). We can't release or close something that's already gone, so we
 * just drop our references and reset status.
 */
function onDeviceLost(dev: LogicDevice): void {
  if (dev !== device) return;
  session?.stop();
  session = null;
  device = null;
  connStatus.set("disconnected");
  deviceLabel.set("");
  statusMessage.set("Device disconnected. Replug it and Connect again.");
}

/**
 * Register the disconnect listeners so unplugging the device shows up in the UI.
 * Called from the device bar on mount, for *every* supported backend — each only
 * reports devices it handed out, so this stays correct across a backend switch.
 * The backends make it idempotent per event target.
 */
export function watchDeviceDisconnect(): void {
  for (const backend of BACKENDS) {
    if (backend.isSupported()) backend.watchDisconnect(onDeviceLost);
  }
}

// --- Capture ---

/** Set by stopCapture(); ends a repeat run after the in-flight capture. */
let repeatStopped = false;

/**
 * Where the trigger matched, or null for "this capture wasn't triggered".
 *
 * `findTrigger` reports a match at sample 0 for an *empty* spec — its way of
 * saying "start at the beginning" — so calling it unguarded draws a marker and
 * relabels the ruler "Time (from trigger)" on a capture nobody triggered.
 */
function triggerMatch(buf: CaptureBuffer, spec: TriggerSpec): number | null {
  if (spec.conditions.length === 0) return null;
  const at = findTrigger(buf, spec);
  return at >= 0 ? at : null;
}

/**
 * Run one or more captures back to back.
 *
 * Two rules hold the repeat loop together. `captureStatus` stays "running" for
 * the whole run, which is what lets the follow view and the live in-view decode
 * roll across capture boundaries — that live view being the point of "until
 * stopped". And a finished capture is never fitted or fully decoded mid-run:
 * that is O(capture) work on a buffer nobody is looking at. Decoding happens on
 * selection, and once at the end.
 */
export async function startCapture(): Promise<void> {
  // A run already in flight owns `session` and `repeatStopped`; a second one
  // would drive the same device concurrently and leave Stop reaching only one
  // of them. Matches startMonitor()'s guard.
  if (!device || get(monitorActive) || get(captureStatus) === "running") return;
  const dev = device;
  const cfg = get(config);
  const caps = dev.capabilities;
  // The device's own divider decides the real rate; that, not the request, is
  // what the buffer's time axis has to be built from.
  const sampleRate = dev.resolveSampleRate(cfg.sampleRate);
  const target = cfg.captures;
  const hasTrigger = cfg.trigger.conditions.length > 0;
  // An open-ended run ends on a trigger match — that is what "until stopped" is
  // for. A fixed count means "give me this many" and runs to completion, which
  // is how you collect occurrences to compare; on a hardware-trigger device
  // every capture is a triggered one, so stopping at the first would cap every
  // run at one.
  const stopOnTrigger = target === CAPTURES_UNTIL_STOPPED && hasTrigger;

  // Run discards what is on screen, and the button has just had exactly that
  // confirmed, so it all goes now — keeping the old trace up while a one-shot
  // device fills its memory was tried and contradicts that promise.
  captures.set([]);
  captureCursor.set(0);
  sampleSource.set("capture");
  decoders.update((list) => list.map((d) => ({ ...d, annotations: [] })));
  detections.set(null); // previous scan no longer applies to the new capture
  captureStatus.set("running");
  repeatStopped = false;

  // *Within* a run, a finished capture stays up until the next one's samples
  // arrive. Swapping the next (empty) buffer in at once — the obvious thing —
  // happens in the same tick as the previous capture's `captureTick`, before the
  // coalesced redraw runs, so that capture is replaced before it is ever drawn.
  let shown: CaptureBuffer | null = null;
  const showCapture = (buf: CaptureBuffer) => {
    shown = buf;
    captureBuffer.set(buf);
    triggerSample.set(null);
  };

  const startedAt = Date.now();
  let records: CaptureRecord[] = [];
  let deviceLost = false;
  let failure: string | null = null;
  let index = 0;

  while (
    !repeatStopped &&
    (target === CAPTURES_UNTIL_STOPPED || index < target)
  ) {
    index++;
    const buf = new CaptureBuffer(
      sampleRate,
      Math.min(cfg.sampleLimit, 1 << 24),
    );
    captureSamples.set(0);
    // The first capture blanks the view the run started by discarding; a
    // streaming device fills in from its first chunk, so it takes it at once too.
    if (caps.streaming || index === 1) showCapture(buf);
    statusMessage.set(armingMessage(caps, cfg, index, target));

    let caught: number | null = null;
    session = dev.acquire(
      { sampleRate, sampleLimit: cfg.sampleLimit, trigger: cfg.trigger },
      {
        onData: (chunk) => {
          if (shown !== buf) showCapture(buf);
          buf.append(chunk);
          captureTick.update((n) => n + 1);
        },
        onProgress: (n) => {
          captureSamples.set(n);
          // A buffered dump has no live waveform to watch, so the status line is
          // the only progress there is while it uploads.
          if (!caps.streaming) {
            statusMessage.set(
              `${capturePrefix(index, target)}reading ${n.toLocaleString()} of ${cfg.sampleLimit.toLocaleString()} samples…`,
            );
          }
        },
        onError: (err) => {
          captureStatus.set("error");
          statusMessage.set(friendlyError(err));
        },
        onTrigger: (sample) => (caught = sample),
      },
    );

    await session.run();
    session = null;

    // A mid-capture unplug nulls `device` (see onDeviceLost). Keep the partial
    // capture, but let the disconnect message stand rather than "Captured N".
    deviceLost = device === null;
    // A real error must not be buried by the finalize status (nothing renders
    // captureStatus === "error", so the message is the only surface).
    if (get(captureStatus) === "error") failure = get(statusMessage);

    // A capture that produced nothing is not a capture. Stopping while a device
    // is still filling its own memory lands here routinely, and recording the
    // empty buffer would leave the pager sitting on a blank capture and hide the
    // real ones behind it.
    if (buf.sampleCount === 0) {
      if (!failure && !deviceLost && !repeatStopped) {
        // Nothing arrived and nobody asked us to stop: without this the loop
        // would spin as fast as the event loop allows.
        statusMessage.set("The device returned no samples — stopping.");
      }
      break;
    }

    const trig = caught ?? triggerMatch(buf, cfg.trigger);
    // The capture is on screen now, so finish rendering it: the trigger mark is
    // free (the match was needed for the record anyway), and the decoder lanes
    // follow when the capture is small enough to afford. Note this decodes but
    // does *not* fit — refitting mid-run is what would fight the view.
    triggerSample.set(trig);
    if (buf.sampleCount <= MAX_LANDED_DECODE_SAMPLES) runAllDecoders();
    records.push({ buffer: buf, atMs: Date.now() - startedAt, trigger: trig });
    records = trimRetained(records);
    captures.set([...records]);
    captureCursor.set(records.length);

    if (failure || deviceLost) break;
    if (stopOnTrigger && trig !== null) break;
  }

  if (get(captureStatus) === "running") captureStatus.set("done");
  // Land on the newest capture that was actually kept — the in-flight one may
  // have been discarded as empty.
  const last = records.at(-1);
  const landed = last?.buffer ?? shown;
  if (landed) {
    captureBuffer.set(landed);
    captureSamples.set(landed.sampleCount);
    finalizeCapture(landed, last?.trigger ?? null, records.length);
  }
  if (failure) statusMessage.set(failure);
  if (deviceLost)
    statusMessage.set("Device disconnected — showing the partial capture.");
}

/** "Capture 3 of 10 — " while repeating, and nothing for a plain single Run. */
function capturePrefix(index: number, target: number): string {
  if (target === 1) return "";
  const of = target === CAPTURES_UNTIL_STOPPED ? "" : ` of ${target}`;
  return `Capture ${index}${of} — `;
}

/** What the status line says while a capture is being taken. A one-shot device
 *  fills its own memory before uploading, so "Capturing…" would be misleading:
 *  nothing is on its way yet, and with a trigger armed nothing may be for a
 *  long while. */
function armingMessage(
  caps: DeviceCapabilities,
  cfg: CaptureConfigState,
  index: number,
  target: number,
): string {
  const what = caps.streaming
    ? "capturing…"
    : caps.hardwareTrigger && cfg.trigger.conditions.length > 0
      ? "armed — waiting for trigger…"
      : "capturing into the device’s memory…";
  const prefix = capturePrefix(index, target);
  return prefix ? prefix + what : what[0].toUpperCase() + what.slice(1);
}

export function stopCapture(): void {
  if (get(captureStatus) !== "running") return;
  repeatStopped = true;
  // Say so straight away: a device mid-capture owes us nothing until it has
  // filled its memory, so the run can take a moment to unwind.
  statusMessage.set("Stopping…");
  session?.stop();
}

/**
 * Show one capture from the last run. This is where a repeat run's decoding
 * actually happens — see startCapture on why it can't happen per capture.
 */
export function selectCapture(index1: number): void {
  const list = get(captures);
  if (list.length === 0 || get(captureStatus) === "running") return;
  const i = Math.max(1, Math.min(index1, list.length));
  const rec = list[i - 1];
  captureCursor.set(i);
  captureBuffer.set(rec.buffer);
  captureSamples.set(rec.buffer.sampleCount);
  triggerSample.set(rec.trigger);
  detections.set(null); // the previous scan described a different capture
  fitAndDecode(
    rec.buffer,
    `Capture ${i} of ${list.length} — ${rec.buffer.sampleCount.toLocaleString()} samples at +${(rec.atMs / 1000).toFixed(2)} s.`,
  );
}

/** Step the capture pager by `delta`. */
export function stepCapture(delta: number): void {
  selectCapture(get(captureCursor) + delta);
}

function finalizeCapture(
  buf: CaptureBuffer,
  trigger: number | null,
  count: number,
): void {
  triggerSample.set(trigger);
  const samples = `${buf.sampleCount.toLocaleString()} samples`;
  fitAndDecode(
    buf,
    count > 1
      ? `Captured ${count} captures — showing ${count} of ${count} (${samples}).`
      : `Captured ${samples}.`,
  );
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
  // A loaded buffer replaces the whole run, not just the shown capture.
  captures.set([]);
  captureCursor.set(0);
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
  // One entry per declared channel, always. A short override would leave holes
  // that ctx.pin() reads as `>> undefined`, i.e. silently physical channel 0 —
  // so an unmapped logical channel falls back to its own index (D0..Dn).
  const channelMap = dec.meta.channels.map(
    (_, i) => overrides?.channelMap?.[i] ?? i,
  );

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

  const uid = `dec${uidCounter++}`;
  decoders.update((list) => {
    const next = [
      ...list,
      {
        uid,
        decoderId,
        label,
        channelMap,
        options,
        annotations: [],
        stackOnUid,
        enabled: true,
      },
    ];
    // Adding a source late: a stacked decoder added first had nothing to bind
    // to, and nothing re-checked afterwards — its Source select rendered blank
    // (no option matches "") and it decoded nothing until the user re-picked.
    if (!dec.meta.outputType) return next;
    return next.map((inst) => {
      if (inst.uid === uid || inst.stackOnUid) return inst;
      const d = getDecoder(inst.decoderId);
      return d?.meta.inputType === dec.meta.outputType
        ? { ...inst, stackOnUid: uid }
        : inst;
    });
  });
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

/** True when every physical channel a decoder reads is still shown. Stacked
 *  decoders map no channels, so they pass and follow their source instead. */
export function decoderChannelsShown(
  inst: DecoderInstance,
  enabledChannels: boolean[],
): boolean {
  return inst.channelMap.every((ch) => enabledChannels[ch] !== false);
}

/** Show/hide one capture channel: a view/decode/export filter (the device sends
 *  every channel it has regardless), so hiding one also stops the decoders
 *  reading it. */
export function setChannelEnabled(ch: number, on: boolean): void {
  const before = get(config).enabledChannels;
  config.update((cfg) => {
    const enabledChannels = [...cfg.enabledChannels];
    enabledChannels[ch] = on;
    return { ...cfg, enabledChannels };
  });
  onChannelsChanged(before);
}

/** Show/hide every channel at once — "all" means all the device actually has. */
export function setAllChannelsEnabled(on: boolean): void {
  const before = get(config).enabledChannels;
  const channels = get(capabilities).channels;
  config.update((cfg) => ({
    ...cfg,
    enabledChannels: Array.from(
      { length: NUM_CHANNELS },
      (_, ch) => on && ch < channels,
    ),
  }));
  onChannelsChanged(before);
}

// Clear the lanes that just lost their channel — refreshDecoders is a no-op
// mid-capture, so waiting for the re-decode would leave them showing. Detection
// results only describe the channels they scanned, so a changed selection
// retires them (closing the pane) the way a new capture does — re-scanning
// instead would be a full O(capture) scan per checkbox click.
function onChannelsChanged(before: boolean[]): void {
  const enabled = get(config).enabledChannels;
  if (enabled.some((on, ch) => on !== before[ch])) detections.set(null);
  decoders.update((list) =>
    list.map((d) =>
      decoderChannelsShown(d, enabled) ? d : { ...d, annotations: [] },
    ),
  );
  refreshDecoders();
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
  // A decoder runs only with the master switch on, its own flag on, and every
  // channel it reads shown; the rest are cleared (no annotations, no packets).
  const masterOn = get(decodersEnabled);
  const enabledChannels = get(config).enabledChannels;
  const active = (inst: DecoderInstance) =>
    masterOn &&
    inst.enabled !== false &&
    decoderChannelsShown(inst, enabledChannels);

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
  // Refused mid-run, as the toolbar's disabled state already is: the scan is
  // O(capture) on the main thread, which is the thread keeping the FX2 fed.
  if (get(captureStatus) === "running") return;
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
 * What the "Detect" button does: scan, or close the results pane if it is already
 * showing. Results are cleared whenever the capture or the channel selection
 * changes, so an open pane always describes the current buffer and channels —
 * re-scanning it would only find the same hits again.
 */
export function toggleDetection(): void {
  if (get(detections) !== null) detections.set(null);
  else runDetection();
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

/** A cancelled/empty device chooser (user closed it without picking). */
function isNoDeviceSelected(err: unknown): boolean {
  const m = errMsg(err).toLowerCase();
  return (
    m.includes("no device selected") ||
    m.includes("no port selected") ||
    m.includes("user gesture")
  );
}

/** Translate common WebUSB / Web Serial errors into guidance a user can act on. */
export function friendlyError(err: unknown): string {
  const raw = errMsg(err);
  const m = raw.toLowerCase();
  if (m.includes("no port selected")) {
    return "No serial port was selected.";
  }
  if (m.includes("failed to open serial port") || m.includes("already open")) {
    return "Could not open the serial port — something else is using it (a terminal, PulseView, the Arduino IDE). Close it, then Connect again.";
  }
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
