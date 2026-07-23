// Shared WebUSB test doubles. `Fx2Device` (src/usb/fx2Device.ts) wraps a
// `USBDevice`, and the firmware/session flows reach WebUSB only through
// `navigator.usb`. These fakes let us drive the whole USB stack under Node —
// no hardware, no browser.
//
// - `FakeUSBDevice` implements just the `USBDevice` surface the app touches,
//   records control/bulk traffic for assertions, and lets tests script the
//   responses (firmware version, REVID, bulk sample stream).
// - `installFakeNavigatorUsb` stubs `navigator.usb` (requestDevice / getDevices
//   / connect events) so `Fx2Device.request()`, `getAuthorized()`, and
//   `waitForReenumeration()` work, and returns a handle to restore it.

/** A control transfer the device received (host -> device). */
export interface RecordedControlOut {
  request: number;
  value: number;
  index: number;
  data: Uint8Array;
}

export interface FakeUSBDeviceOptions {
  vendorId?: number;
  productId?: number;
  manufacturerName?: string | null;
  productName?: string | null;
  /** Endpoint number (low nibble) reported as the bulk-IN endpoint. */
  bulkInEndpointNumber?: number;
  /** Bytes returned for CMD_GET_FW_VERSION (major, minor). */
  firmwareVersion?: [number, number];
  /** Byte returned for CMD_GET_REVID_VERSION. */
  revid?: number;
  /**
   * Optional custom handler for control-IN (device -> host). Return the bytes
   * for the given request, or undefined to fall back to the built-in
   * firmware-version / REVID responses.
   */
  onControlIn?: (
    request: number,
    value: number,
    length: number,
  ) => Uint8Array | undefined;
  /**
   * Bulk-IN sample stream. Each call to transferIn() shifts one chunk; when the
   * queue is empty it returns a zero-length 'ok' result (idle FIFO). Provide a
   * function for lazy/infinite streams.
   */
  bulkChunks?: Uint8Array[] | (() => Uint8Array | null);
}

type ConnectListener = (ev: unknown) => void;

const CMD_GET_FW_VERSION = 0xb0;
const CMD_GET_REVID_VERSION = 0xb2;

/** Minimal in-memory stand-in for a WebUSB USBDevice. */
export class FakeUSBDevice {
  vendorId: number;
  productId: number;
  manufacturerName: string | null;
  productName: string | null;
  opened = false;
  configuration: USBConfiguration | null = null;

  // --- recorded interactions (for assertions) ---
  readonly controlOut: RecordedControlOut[] = [];
  openCalls = 0;
  closeCalls = 0;
  claimedInterfaces: number[] = [];
  releasedInterfaces: number[] = [];
  resetCalls = 0;
  selectConfigCalls = 0;

  private readonly opts: FakeUSBDeviceOptions;
  private readonly bulkNumber: number;
  private bulkQueue: Uint8Array[] | null;
  private readonly bulkFn: (() => Uint8Array | null) | null;

  constructor(opts: FakeUSBDeviceOptions = {}) {
    this.opts = opts;
    this.vendorId = opts.vendorId ?? 0x1d50;
    this.productId = opts.productId ?? 0x608c;
    // Distinguish "omitted" (use default identity) from an explicit null, so
    // tests can drive genuinely-absent string descriptors.
    this.manufacturerName =
      opts.manufacturerName !== undefined ? opts.manufacturerName : "sigrok";
    this.productName =
      opts.productName !== undefined ? opts.productName : "fx2lafw";
    this.bulkNumber = opts.bulkInEndpointNumber ?? 2;
    this.bulkQueue = Array.isArray(opts.bulkChunks)
      ? [...opts.bulkChunks]
      : null;
    this.bulkFn =
      typeof opts.bulkChunks === "function" ? opts.bulkChunks : null;
  }

  private makeConfiguration(): USBConfiguration {
    const endpoints = [
      {
        endpointNumber: this.bulkNumber,
        direction: "in",
        type: "bulk",
        packetSize: 512,
      },
      {
        endpointNumber: this.bulkNumber,
        direction: "out",
        type: "bulk",
        packetSize: 512,
      },
    ];
    return {
      configurationValue: 1,
      configurationName: undefined,
      interfaces: [
        {
          interfaceNumber: 0,
          claimed: false,
          alternate: {
            alternateSetting: 0,
            interfaceClass: 255,
            interfaceSubclass: 0,
            interfaceProtocol: 0,
            interfaceName: undefined,
            endpoints,
          },
          alternates: [],
        },
      ],
    } as unknown as USBConfiguration;
  }

  async open(): Promise<void> {
    this.openCalls++;
    this.opened = true;
  }

  async close(): Promise<void> {
    this.closeCalls++;
    this.opened = false;
  }

  async selectConfiguration(_value: number): Promise<void> {
    this.selectConfigCalls++;
    this.configuration = this.makeConfiguration();
  }

  async claimInterface(n: number): Promise<void> {
    if (!this.configuration) this.configuration = this.makeConfiguration();
    this.claimedInterfaces.push(n);
  }

  async releaseInterface(n: number): Promise<void> {
    this.releasedInterfaces.push(n);
  }

  async reset(): Promise<void> {
    this.resetCalls++;
  }

  async controlTransferOut(
    setup: USBControlTransferParameters,
    data?: BufferSource,
  ): Promise<USBOutTransferResult> {
    // Copy honoring the view's byteOffset/byteLength so a subarray chunk (e.g.
    // firmware upload) records exactly its own bytes, not the whole backing buffer.
    let bytes: Uint8Array;
    if (!data) {
      bytes = new Uint8Array(0);
    } else if (data instanceof ArrayBuffer) {
      bytes = new Uint8Array(data.slice(0));
    } else {
      const v = data as ArrayBufferView;
      bytes = new Uint8Array(
        v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength),
      );
    }
    this.controlOut.push({
      request: setup.request,
      value: setup.value,
      index: setup.index,
      data: bytes,
    });
    return { status: "ok", bytesWritten: bytes.length };
  }

  async controlTransferIn(
    setup: USBControlTransferParameters,
    length: number,
  ): Promise<USBInTransferResult> {
    let bytes = this.opts.onControlIn?.(setup.request, setup.value, length);
    if (!bytes) {
      if (setup.request === CMD_GET_FW_VERSION) {
        bytes = new Uint8Array(this.opts.firmwareVersion ?? [1, 3]);
      } else if (setup.request === CMD_GET_REVID_VERSION) {
        bytes = new Uint8Array([this.opts.revid ?? 1]);
      } else {
        bytes = new Uint8Array(length);
      }
    }
    return {
      status: "ok",
      data: new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    };
  }

  async transferIn(
    _endpointNumber: number,
    length: number,
  ): Promise<USBInTransferResult> {
    let chunk: Uint8Array | null = null;
    if (this.bulkFn) chunk = this.bulkFn();
    else if (this.bulkQueue) chunk = this.bulkQueue.shift() ?? null;
    const data = chunk ?? new Uint8Array(0);
    const clipped = data.length > length ? data.subarray(0, length) : data;
    return {
      status: "ok",
      data: new DataView(
        clipped.buffer,
        clipped.byteOffset,
        clipped.byteLength,
      ),
    };
  }
}

export interface FakeNavigatorUsbHandle {
  usb: {
    requestDevice(options: unknown): Promise<USBDevice>;
    getDevices(): Promise<USBDevice[]>;
    addEventListener(type: string, cb: ConnectListener): void;
    removeEventListener(type: string, cb: ConnectListener): void;
  };
  /** Devices returned by getDevices(); mutate to simulate re-enumeration. */
  authorized: FakeUSBDevice[];
  /** Fire a `connect` event (e.g. after swapping `authorized`). */
  emitConnect(): void;
  /** Fire a `disconnect` event for the given device (defaults to none). */
  emitDisconnect(device?: FakeUSBDevice): void;
  /** Restore the previous navigator.usb (or delete it). */
  restore(): void;
}

export interface InstallOptions {
  /** Device handed back by requestDevice(). */
  requestDevice?: FakeUSBDevice;
  /** Devices visible to getDevices() (already-authorized). */
  authorized?: FakeUSBDevice[];
}

/**
 * Install a fake `navigator.usb`. Returns a handle to drive re-enumeration and
 * to restore the original. Creates `globalThis.navigator` if absent (Node env).
 */
export function installFakeNavigatorUsb(
  opts: InstallOptions = {},
): FakeNavigatorUsbHandle {
  const listeners = new Map<string, Set<ConnectListener>>();
  const authorized = opts.authorized ?? [];

  const usb = {
    async requestDevice(): Promise<USBDevice> {
      if (!opts.requestDevice) throw new Error("No device selected");
      return opts.requestDevice as unknown as USBDevice;
    },
    async getDevices(): Promise<USBDevice[]> {
      return authorized as unknown as USBDevice[];
    },
    addEventListener(type: string, cb: ConnectListener): void {
      (listeners.get(type) ?? listeners.set(type, new Set()).get(type)!).add(
        cb,
      );
    },
    removeEventListener(type: string, cb: ConnectListener): void {
      listeners.get(type)?.delete(cb);
    },
  };

  const nav = (globalThis as { navigator?: Navigator }).navigator;
  const had = nav && "usb" in nav;
  const prev = had ? (nav as unknown as { usb: unknown }).usb : undefined;
  if (!nav) {
    (globalThis as { navigator?: unknown }).navigator = { usb };
  } else {
    Object.defineProperty(nav, "usb", {
      value: usb,
      configurable: true,
      writable: true,
    });
  }

  return {
    usb,
    authorized,
    emitConnect() {
      for (const cb of listeners.get("connect") ?? []) cb({});
    },
    emitDisconnect(device?: FakeUSBDevice) {
      for (const cb of listeners.get("disconnect") ?? []) cb({ device });
    },
    restore() {
      const n = (globalThis as { navigator?: Navigator }).navigator;
      if (!n) return;
      if (had)
        Object.defineProperty(n, "usb", {
          value: prev,
          configurable: true,
          writable: true,
        });
      else delete (n as unknown as { usb?: unknown }).usb;
    },
  };
}
