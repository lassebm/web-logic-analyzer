import { USB_FILTERS } from "./constants";

/** Thin wrapper around a WebUSB USBDevice with fx2lafw-oriented helpers. */
export class Fx2Device {
  readonly device: USBDevice;
  private interfaceNumber = 0;
  private bulkInEndpoint = 0x82; // resolved from descriptors on claim()
  private claimed = false;

  constructor(device: USBDevice) {
    this.device = device;
  }

  static isSupported(): boolean {
    return typeof navigator !== "undefined" && "usb" in navigator;
  }

  /** Prompt the user to pick a device matching our filters. */
  static async request(): Promise<Fx2Device> {
    if (!Fx2Device.isSupported())
      throw new Error("WebUSB is not available in this browser.");
    const device = await navigator.usb.requestDevice({ filters: USB_FILTERS });
    return new Fx2Device(device);
  }

  /** Return previously-authorized devices without prompting. */
  static async getAuthorized(): Promise<Fx2Device[]> {
    if (!Fx2Device.isSupported()) return [];
    const devices = await navigator.usb.getDevices();
    return devices.map((d) => new Fx2Device(d));
  }

  get vendorId(): number {
    return this.device.vendorId;
  }
  get productId(): number {
    return this.device.productId;
  }
  get manufacturerName(): string | undefined {
    return this.device.manufacturerName ?? undefined;
  }
  get productName(): string | undefined {
    return this.device.productName ?? undefined;
  }
  get opened(): boolean {
    return this.device.opened;
  }
  get bulkIn(): number {
    return this.bulkInEndpoint;
  }

  async open(): Promise<void> {
    if (!this.device.opened) await this.device.open();
    if (this.device.configuration === null) {
      try {
        await this.device.selectConfiguration(1);
      } catch (err) {
        // Some platforms report the configuration as already applied; only
        // surface the error if the device genuinely has no configuration.
        if (this.device.configuration === null) throw err;
      }
    }
  }

  /**
   * Claim the interface and resolve the bulk-IN endpoint address from the
   * descriptor (modern fx2lafw uses EP 0x82; older/clone firmware used 0x86).
   */
  async claim(): Promise<void> {
    await this.open();
    const config = this.device.configuration;
    if (!config) throw new Error("No USB configuration selected.");

    const iface = config.interfaces[0];
    if (!iface) throw new Error("Device exposes no USB interface.");
    this.interfaceNumber = iface.interfaceNumber;
    if (!this.claimed) {
      await this.device.claimInterface(this.interfaceNumber);
      this.claimed = true;
    }

    const alt = iface.alternate;
    if (!alt)
      throw new Error("Device interface has no active alternate setting.");
    const bulkIn = alt.endpoints.find(
      (e) => e.direction === "in" && e.type === "bulk",
    );
    if (bulkIn) this.bulkInEndpoint = bulkIn.endpointNumber | 0x80;
  }

  /**
   * Reset the device to abort any in-flight transfers (WebUSB has no per-transfer
   * cancel). This drops the interface claim, so the next claim() re-acquires it.
   */
  async reset(): Promise<void> {
    try {
      await this.device.reset();
    } catch {
      /* device may be mid-teardown */
    }
    this.claimed = false;
  }

  async release(): Promise<void> {
    try {
      if (this.device.opened) {
        await this.device.releaseInterface(this.interfaceNumber);
      }
    } catch {
      /* interface may already be gone (e.g. after firmware re-enumeration) */
    }
    this.claimed = false;
  }

  async close(): Promise<void> {
    try {
      if (this.device.opened) await this.device.close();
    } catch {
      /* ignore */
    }
  }

  /** Vendor control transfer, host -> device. */
  async controlOut(
    request: number,
    value: number,
    data?: BufferSource,
  ): Promise<void> {
    const result = await this.device.controlTransferOut(
      { requestType: "vendor", recipient: "device", request, value, index: 0 },
      data,
    );
    if (result.status !== "ok") {
      throw new Error(
        `controlOut(req=0x${request.toString(16)}) status=${result.status}`,
      );
    }
  }

  /** Vendor control transfer, device -> host. */
  async controlIn(
    request: number,
    value: number,
    length: number,
  ): Promise<DataView> {
    const result = await this.device.controlTransferIn(
      { requestType: "vendor", recipient: "device", request, value, index: 0 },
      length,
    );
    if (result.status !== "ok" || !result.data) {
      throw new Error(
        `controlIn(req=0x${request.toString(16)}) status=${result.status}`,
      );
    }
    return result.data;
  }

  /** Read one bulk transfer of up to `length` bytes from the sample endpoint. */
  async readBulk(length: number): Promise<USBInTransferResult> {
    return this.device.transferIn(this.bulkInEndpoint & 0x0f, length);
  }
}
