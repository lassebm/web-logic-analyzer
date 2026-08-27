// FX2 / fx2lafw backend. Wraps the existing usb/ layer — Fx2Device plus
// CaptureSession — and owns the firmware upload / re-enumerate / reselect flow
// that used to live in stores/session.provision(). usb/ itself knows nothing
// about this abstraction.

import { Fx2Device } from "../usb/fx2Device";
import {
  needsFirmware,
  uploadFirmware,
  waitForReenumeration,
} from "../usb/firmware";
import { get } from "svelte/store";
import { loadFirmware } from "../usb/firmwareStore";
import { firmwareInfo } from "../usb/firmwareState";
import { loadBundledFirmware } from "../firmware";
import { CaptureSession, getFirmwareVersion, getRevId } from "../usb/capture";
import { PRE_FIRMWARE_DEVICES } from "../usb/constants";
import { SAMPLE_RATES } from "../usb/sampleRate";
import { NUM_CHANNELS } from "./channels";
import type {
  Acquisition,
  AcquisitionRequest,
  CaptureCallbacks,
  ConnectContext,
  ConnectResult,
  DeviceBackend,
  DeviceCapabilities,
  LogicDevice,
} from "./types";

/** Sample-count options. fx2lafw streams, so the only bound is host memory. */
const FX2_SAMPLE_LIMITS = [
  10_000, 100_000, 1_000_000, 5_000_000, 10_000_000, 50_000_000, 100_000_000,
];

export const FX2_CAPABILITIES: DeviceCapabilities = {
  channels: NUM_CHANNELS,
  sampleRates: SAMPLE_RATES,
  sampleLimits: FX2_SAMPLE_LIMITS,
  // The FX2 streams continuously and has no trigger unit; triggering is done in
  // software after the fact (model/trigger.ts), matching sigrok.
  hardwareTrigger: false,
  streaming: true,
  continuous: true,
};

export class Fx2LogicDevice implements LogicDevice {
  readonly capabilities = FX2_CAPABILITIES;

  constructor(
    readonly dev: Fx2Device,
    readonly label: string,
    /** Lets the backend forget this device once it is gone. */
    private readonly onClosed?: (dev: Fx2LogicDevice) => void,
  ) {}

  /** Every entry of SAMPLE_RATES divides one of the FX2 clocks exactly. */
  resolveSampleRate(hz: number): number {
    return hz;
  }

  acquire(req: AcquisitionRequest, cb: CaptureCallbacks): Acquisition {
    return new CaptureSession(
      this.dev,
      {
        sampleRate: req.sampleRate,
        sampleLimit: req.sampleLimit,
        transferSize: req.transferSize,
      },
      cb,
    );
  }

  async close(): Promise<void> {
    await this.dev.release();
    await this.dev.close();
    this.onClosed?.(this);
  }
}

function hex4(n: number): string {
  return "0x" + n.toString(16).padStart(4, "0");
}

class Fx2Backend implements DeviceBackend {
  readonly id = "fx2" as const;
  readonly name = "FX2 (USB)";
  readonly defaultCapabilities = FX2_CAPABILITIES;
  readonly unsupportedMessage =
    "WebUSB is not available. Use Chrome, Edge, or another Chromium browser.";

  /** Devices handed out and not yet closed, so watchDisconnect() can name the
   *  LogicDevice a `navigator.usb` disconnect event refers to. */
  private readonly live = new Set<Fx2LogicDevice>();
  private disconnectTarget: USB | null = null;

  isSupported(): boolean {
    return Fx2Device.isSupported();
  }

  async connect(ctx: ConnectContext): Promise<ConnectResult> {
    ctx.status("Requesting device…");
    return this.provision(await Fx2Device.request(), ctx);
  }

  async reconnect(ctx: ConnectContext): Promise<ConnectResult> {
    const authorized = await Fx2Device.getAuthorized();
    const ready = authorized.find((d) => !needsFirmware(d));
    if (!ready) return { kind: "none" };
    return this.provision(ready, ctx);
  }

  watchDisconnect(onLost: (dev: LogicDevice) => void): void {
    const usb = navigator.usb;
    if (!usb || typeof usb.addEventListener !== "function") return;
    // Idempotent per `navigator.usb` object (re-registers only if it is
    // swapped, e.g. between tests).
    if (this.disconnectTarget === usb) return;
    this.disconnectTarget = usb;
    usb.addEventListener("disconnect", ((event: { device?: USBDevice }) => {
      for (const dev of this.live) {
        if (dev.dev.device === event.device) {
          this.live.delete(dev);
          onLost(dev);
        }
      }
    }) as EventListener);
  }

  /**
   * Bring a chosen device up to "running fx2lafw and claimed". A device still on
   * its stock identity gets firmware uploaded first, which re-enumerates it —
   * and that only reconnects automatically if this origin already holds
   * permission for the running-fx2lafw identity, so a first connect ends in
   * `reselect` rather than a dead end.
   */
  private async provision(
    dev: Fx2Device,
    ctx: ConnectContext,
  ): Promise<ConnectResult> {
    await dev.open();
    let device = dev;

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
        await dev.close();
        return {
          kind: "need-firmware",
          message: `This device needs fx2lafw firmware, and no bundled match was found.${hint} Download it (link in the top bar), load the .fw, then Connect again.`,
        };
      }

      ctx.status(`Uploading firmware — ${source}…`);
      ctx.progress?.(0);
      await uploadFirmware(dev, image, (done, total) =>
        ctx.progress?.(done / total),
      );
      await dev.close();

      ctx.status("Waiting for device to re-enumerate…");
      const reenum = await waitForReenumeration();
      if (!reenum) {
        return {
          kind: "reselect",
          message:
            "Firmware uploaded. Click “Finish connecting” and pick the device from the list.",
        };
      }
      device = reenum;
    }

    await device.claim();
    const ver = await getFirmwareVersion(device);
    let revid = -1;
    try {
      revid = await getRevId(device);
    } catch {
      /* optional */
    }
    const label = `${device.productName ?? "fx2lafw"} — fw ${ver.major}.${ver.minor}${
      revid >= 0 ? `, rev ${revid}` : ""
    }`;
    const logic = new Fx2LogicDevice(device, label, (d) => this.live.delete(d));
    this.live.add(logic);
    return { kind: "device", device: logic };
  }
}

export const fx2Backend: DeviceBackend = new Fx2Backend();
