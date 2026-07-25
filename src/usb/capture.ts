import {
  CMD_GET_FW_VERSION,
  CMD_GET_REVID_VERSION,
  CMD_START,
  FX2LAFW_REQUIRED_VERSION_MAJOR,
} from "./constants";
import { Fx2Device } from "./fx2Device";
import { encodeSampleRate } from "./sampleRate";

export interface FirmwareVersion {
  major: number;
  minor: number;
}

/** Read and validate the running firmware version. */
export async function getFirmwareVersion(
  dev: Fx2Device,
): Promise<FirmwareVersion> {
  const data = await dev.controlIn(CMD_GET_FW_VERSION, 0, 2);
  if (data.byteLength < 2) {
    throw new Error("Device returned a malformed firmware-version response.");
  }
  const version = { major: data.getUint8(0), minor: data.getUint8(1) };
  if (version.major !== FX2LAFW_REQUIRED_VERSION_MAJOR) {
    throw new Error(
      `Unsupported fx2lafw firmware version ${version.major}.${version.minor} (need major ${FX2LAFW_REQUIRED_VERSION_MAJOR})`,
    );
  }
  return version;
}

/** Read the FX2 silicon REVID (informational). */
export async function getRevId(dev: Fx2Device): Promise<number> {
  const data = await dev.controlIn(CMD_GET_REVID_VERSION, 0, 1);
  if (data.byteLength < 1) {
    throw new Error("Device returned a malformed rev-id response.");
  }
  return data.getUint8(0);
}

export interface CaptureConfig {
  sampleRate: number;
  /** Total samples (bytes, in 8-bit mode) to collect before auto-stopping. */
  sampleLimit: number;
  /** Bulk transfer size in bytes; must be a multiple of 512. Defaults to
   *  `transferPlan()`, which scales it with the sample rate. */
  transferSize?: number;
  /** Number of bulk transfers to keep in flight; defaults to `transferPlan()`. */
  transferDepth?: number;
  /** Silence (ms) that counts as a dead stream; defaults to `stallTimeout()`. */
  stallTimeoutMs?: number;
}

/** Samples (in ms of capture time) one bulk transfer should hold. */
const TRANSFER_MS = 10;
/** Capture time the whole in-flight queue should absorb. */
const QUEUE_MS = 500;
/** Cap on queued transfers, matching libsigrok's NUM_SIMUL_TRANSFERS. */
const MAX_TRANSFER_DEPTH = 32;

/**
 * Bulk transfer size and queue depth for a sample rate — libsigrok's fx2lafw
 * sizing: each buffer holds ~10 ms of samples, and the queue ~500 ms in total.
 *
 * The queue length *is* the app's tolerance for a busy main thread. The FX2 has
 * no flow control: the moment the host stops draining the endpoint, its FIFO
 * overflows and the stream is dead for good (no restart, see run()). Only queued
 * transfers keep draining while JS is busy rendering, decoding or in GC — and a
 * fixed 8 × 64 KB is just 21 ms of slack at 24 MHz, so a single slow frame ends
 * the capture. Scaled, 24 MHz gets ~235 KB × 32 ≈ 320 ms.
 *
 * An explicit `transferSize` (the serial monitor wants small, low-latency reads)
 * is honoured, with the depth then derived from it.
 */
export function transferPlan(
  sampleRate: number,
  transferSize?: number,
): { transferSize: number; depth: number } {
  const bytesPerMs = sampleRate / 1000; // 8-bit mode: one byte per sample
  const size =
    transferSize ??
    Math.max(512, Math.ceil((bytesPerMs * TRANSFER_MS) / 512) * 512);
  const depth = Math.round((bytesPerMs * QUEUE_MS) / size);
  return {
    transferSize: size,
    depth: Math.min(MAX_TRANSFER_DEPTH, Math.max(2, depth)),
  };
}

/** Floor for the stall timeout, so fast rates still get a little slack. */
const MIN_STALL_MS = 3000;
/** Ceiling, so the slowest rates (and a bogus one) can't wait absurdly long. */
const MAX_STALL_MS = 60_000;
/** Multiples of one transfer's fill time before silence counts as a stall. */
const STALL_FILL_FACTOR = 6;

/**
 * How long silence from the device may last before the stream counts as dead.
 * Derived from how long one transfer takes to fill at `sampleRate`, since a
 * 64 KB transfer at 20 kHz legitimately takes seconds — a fixed bound would
 * either cut slow captures short or leave fast ones hanging.
 */
export function stallTimeout(transferSize: number, sampleRate: number): number {
  const fillMs = (transferSize / sampleRate) * 1000;
  return Math.min(
    MAX_STALL_MS,
    Math.max(MIN_STALL_MS, fillMs * STALL_FILL_FACTOR),
  );
}

/** Resolved by the stall timer; distinguishable from any transfer result. */
const TIMED_OUT = Symbol("stalled");

const STALL_MESSAGE =
  "The device stopped sending samples, and the FX2 cannot resume a stalled stream. Usually the sample rate is more than the USB link can sustain — try a lower one. It also happens if the page was blocked mid-capture, by a reload prompt say, in which case just press Run again.";

/**
 * Await a bulk transfer, giving up after `ms` of silence. Rejections pass
 * through untouched; only the *absence* of a result is reported, as TIMED_OUT.
 */
async function readOrTimeout(
  pending: Promise<USBInTransferResult>,
  ms: number,
): Promise<USBInTransferResult | typeof TIMED_OUT> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      pending,
      new Promise<typeof TIMED_OUT>((resolve) => {
        timer = setTimeout(() => resolve(TIMED_OUT), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export interface CaptureCallbacks {
  onData: (chunk: Uint8Array) => void;
  onProgress?: (samplesCollected: number) => void;
  onError?: (err: unknown) => void;
}

/**
 * A running acquisition. fx2lafw streams continuously once CMD_START is sent;
 * there is no stop command, so we halt by ceasing to issue transfers and
 * resetting the device (matching libsigrok's abort-and-reset behaviour).
 */
export class CaptureSession {
  private stopped = false;
  private aborted = false;
  private collected = 0;

  constructor(
    private readonly dev: Fx2Device,
    private readonly config: CaptureConfig,
    private readonly cb: CaptureCallbacks,
  ) {}

  /** Send CMD_START and stream bulk data until the sample limit or stop(). */
  async run(): Promise<void> {
    // fx2lafw streams continuously and expects the host to keep several bulk
    // transfers in flight (like libsigrok's transfer pool). Reading one at a
    // time lets the FX2 FIFO overflow between transfers, stalling the stream
    // after the first buffer — so we keep `depth` transfers queued and process
    // them in submission order (WebUSB completes same-endpoint IN transfers in
    // order), resubmitting each as it drains. Both figures scale with the rate:
    // see transferPlan(), which is what makes 16/24 MHz survivable.
    const plan = transferPlan(this.config.sampleRate, this.config.transferSize);
    const transferSize = plan.transferSize;
    const depth = this.config.transferDepth ?? plan.depth;
    // A hostile/buggy device can return "ok" with a zero-length payload (or a
    // non-stall soft error) on every transfer. Those paths don't advance
    // `collected`, so without a bound the loop would resubmit forever, pegging a
    // core. Abort after this many consecutive no-progress transfers.
    const maxIdleTransfers = depth * 4;
    let idleTransfers = 0;

    // fx2lafw has no stop command and no way to restart a stream it has stopped:
    // if the host ever falls behind — the page blocked mid-capture by a modal
    // prompt, a suspended machine — the FX2 FIFO overflows and the endpoint goes
    // quiet for good. A bulk IN read on a quiet endpoint never settles, so
    // without this bound the loop waits forever and the caller stays stuck on
    // "capturing".
    const stallMs =
      this.config.stallTimeoutMs ??
      stallTimeout(transferSize, this.config.sampleRate);

    const inflight: Array<Promise<USBInTransferResult>> = [];
    const canSubmit = () =>
      !this.stopped && this.collected < this.config.sampleLimit;

    try {
      // Claiming and CMD_START belong inside the try: a stalled start command or
      // a claim lost to another program must reach cb.onError like any streaming
      // failure, not reject run() and strand the caller's "capturing" state.
      // Re-claim in case a previous capture reset the device (dropping the claim).
      await this.dev.claim();
      const { flags, sampleDelayH, sampleDelayL } = encodeSampleRate(
        this.config.sampleRate,
      );
      const startCmd = new Uint8Array([flags, sampleDelayH, sampleDelayL]);
      await this.dev.controlOut(CMD_START, 0, startCmd);

      for (let i = 0; i < depth && canSubmit(); i++)
        inflight.push(this.dev.readBulk(transferSize));

      while (
        inflight.length > 0 &&
        !this.stopped &&
        this.collected < this.config.sampleLimit
      ) {
        const pending = inflight.shift()!;
        // Keep the pipe full: resubmit before processing the drained transfer.
        if (canSubmit()) inflight.push(this.dev.readBulk(transferSize));

        let result: USBInTransferResult;
        try {
          const settled = await readOrTimeout(pending, stallMs);
          if (settled === TIMED_OUT) {
            // Back onto the queue: halt() rejects it via reset(), and only the
            // transfers still listed get their rejection swallowed below.
            inflight.unshift(pending);
            throw new Error(STALL_MESSAGE);
          }
          result = settled;
        } catch (err) {
          if (this.stopped) break; // reset() aborted the transfers as requested
          throw err;
        }
        if (this.stopped) break;
        if (
          result.status !== "ok" ||
          !result.data ||
          result.data.byteLength === 0
        ) {
          if (result.status === "stall") break;
          if (++idleTransfers > maxIdleTransfers) {
            throw new Error(
              "Device returned no sample data — aborting capture.",
            );
          }
          continue;
        }
        idleTransfers = 0;
        let chunk = new Uint8Array(result.data.buffer);
        const remaining = this.config.sampleLimit - this.collected;
        if (chunk.length > remaining) chunk = chunk.subarray(0, remaining);
        this.collected += chunk.length;
        this.cb.onData(chunk);
        this.cb.onProgress?.(this.collected);
      }
    } catch (err) {
      if (!this.stopped) this.cb.onError?.(err);
    } finally {
      // A failed claim/start leaves nothing to reset, and a reset that itself
      // throws must not replace the error we already reported.
      try {
        await this.halt();
      } catch {
        /* teardown is best-effort */
      }
      // Swallow rejections from transfers aborted by the reset in halt().
      await Promise.allSettled(inflight);
    }
  }

  /**
   * Stop streaming immediately. Sets the flag and resets the device to abort any
   * in-flight bulk transfer (WebUSB cannot cancel a single transfer otherwise).
   */
  stop(): void {
    this.stopped = true;
    void this.abort();
  }

  private async abort(): Promise<void> {
    if (this.aborted) return;
    this.aborted = true;
    await this.dev.reset();
  }

  private async halt(): Promise<void> {
    this.stopped = true;
    // Reset also stops the FX2 streaming on normal completion (fx2lafw has no
    // stop command). Skip if stop() already reset the device.
    if (!this.aborted) await this.abort();
  }
}
