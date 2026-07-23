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
  /** Bulk transfer size in bytes; must be a multiple of 512. */
  transferSize?: number;
  /** Number of bulk transfers to keep in flight (default 8). */
  transferDepth?: number;
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
    // Re-claim in case a previous capture reset the device (which drops the claim).
    await this.dev.claim();

    const { flags, sampleDelayH, sampleDelayL } = encodeSampleRate(
      this.config.sampleRate,
    );
    const startCmd = new Uint8Array([flags, sampleDelayH, sampleDelayL]);
    await this.dev.controlOut(CMD_START, 0, startCmd);

    // fx2lafw streams continuously and expects the host to keep several bulk
    // transfers in flight (like libsigrok's transfer pool). Reading one at a
    // time lets the FX2 FIFO overflow between transfers, stalling the stream
    // after the first buffer — so we keep DEPTH transfers queued and process
    // them in submission order (WebUSB completes same-endpoint IN transfers in
    // order), resubmitting each as it drains.
    const transferSize = this.config.transferSize ?? 64 * 1024;
    const depth = this.config.transferDepth ?? 8;
    // A hostile/buggy device can return "ok" with a zero-length payload (or a
    // non-stall soft error) on every transfer. Those paths don't advance
    // `collected`, so without a bound the loop would resubmit forever, pegging a
    // core. Abort after this many consecutive no-progress transfers.
    const maxIdleTransfers = depth * 4;
    let idleTransfers = 0;

    const inflight: Array<Promise<USBInTransferResult>> = [];
    const canSubmit = () =>
      !this.stopped && this.collected < this.config.sampleLimit;
    for (let i = 0; i < depth && canSubmit(); i++)
      inflight.push(this.dev.readBulk(transferSize));

    try {
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
          result = await pending;
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
      await this.halt();
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
