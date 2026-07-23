// Protocol constants for FX2LP / fx2lafw devices.
// Sourced from libsigrok: src/ezusb.c, src/hardware/fx2lafw/{api,protocol}.{c,h}.

/** Cypress FX2LP bootloader vendor request for RAM read/write ("firmware load"). */
export const REQ_FIRMWARE_LOAD = 0xa0;

/** CPUCS register address; bit 0 (8051RES) holds/releases the CPU in reset. */
export const CPUCS_ADDR = 0xe600;

/** Max bytes per firmware-load control transfer chunk. */
export const FW_CHUNK_SIZE = 4096;

/** fx2lafw vendor commands (bRequest values on vendor control transfers). */
export const CMD_GET_FW_VERSION = 0xb0; // IN  -> { major, minor }
export const CMD_START = 0xb1; // OUT -> cmd_start_acquisition (3 bytes)
export const CMD_GET_REVID_VERSION = 0xb2; // IN  -> { revid }

/** Required firmware major version (libsigrok FX2LAFW_REQUIRED_VERSION_MAJOR). */
export const FX2LAFW_REQUIRED_VERSION_MAJOR = 1;

// cmd_start_acquisition.flags bits
export const CMD_START_FLAGS_SAMPLE_8BIT = 0x00; // bit5 = 0
export const CMD_START_FLAGS_SAMPLE_16BIT = 0x20; // bit5 = 1
export const CMD_START_FLAGS_CLK_30MHZ = 0x00; // bit6 = 0
export const CMD_START_FLAGS_CLK_48MHZ = 0x40; // bit6 = 1

/** Max value of the 16-bit sample delay divisor. */
export const MAX_SAMPLE_DELAY = 1536;

/** Base clocks the FX2 can divide from. */
export const CLK_48MHZ = 48_000_000;
export const CLK_30MHZ = 30_000_000;

export interface UsbId {
  vendorId: number;
  productId: number;
}

export interface DeviceProfile extends UsbId {
  name: string;
  /** Bundled firmware filename to auto-load for this device (key into the firmware URL map). */
  firmware: string;
}

/**
 * Devices that present a stock/bootloader identity and need fx2lafw uploaded.
 * Mirrors libsigrok's fx2lafw supported-devices table.
 */
export const PRE_FIRMWARE_DEVICES: DeviceProfile[] = [
  {
    vendorId: 0x04b4,
    productId: 0x8613,
    name: "Cypress FX2",
    firmware: "fx2lafw-cypress-fx2.fw",
  },
  {
    vendorId: 0x0925,
    productId: 0x3881,
    name: "Saleae Logic (clone)",
    firmware: "fx2lafw-saleae-logic.fw",
  },
  {
    vendorId: 0x08a9,
    productId: 0x0014,
    name: "CWAV USBee AX",
    firmware: "fx2lafw-cwav-usbeeax.fw",
  },
  {
    vendorId: 0x08a9,
    productId: 0x0015,
    name: "CWAV USBee DX",
    firmware: "fx2lafw-cwav-usbeedx.fw",
  },
  {
    vendorId: 0x16d0,
    productId: 0x0498,
    name: "Braintechnology USB-LPS",
    firmware: "fx2lafw-braintechnology-usb-lps.fw",
  },
  {
    vendorId: 0x1d50,
    productId: 0x608c,
    name: "sigrok FX2 LA (8ch)",
    firmware: "fx2lafw-sigrok-fx2-8ch.fw",
  },
  {
    vendorId: 0x1d50,
    productId: 0x608d,
    name: "sigrok FX2 LA (16ch)",
    firmware: "fx2lafw-sigrok-fx2-16ch.fw",
  },
];

/**
 * Identities a device advertises once fx2lafw is running. We also treat any
 * device whose string descriptors read sigrok/fx2lafw as ready (see firmware.ts).
 */
export const POST_FIRMWARE_DEVICES: UsbId[] = [
  { vendorId: 0x1d50, productId: 0x608c }, // 8ch
  { vendorId: 0x1d50, productId: 0x608d }, // 16ch
  { vendorId: 0x1d50, productId: 0x608f }, // usb-c-grok
];

/** Combined USB filters for navigator.usb.requestDevice(). */
export const USB_FILTERS: USBDeviceFilter[] = [
  ...PRE_FIRMWARE_DEVICES.map((d) => ({
    vendorId: d.vendorId,
    productId: d.productId,
  })),
  ...POST_FIRMWARE_DEVICES.map((d) => ({
    vendorId: d.vendorId,
    productId: d.productId,
  })),
];

/** Manufacturer string reported by a device already running fx2lafw. */
export const SIGROK_MANUFACTURER = "sigrok";
/** Product string reported by a device already running fx2lafw. */
export const FX2LAFW_PRODUCT = "fx2lafw";

/** Number of logic channels in 8-bit mode. */
export const NUM_CHANNELS = 8;

/** Display names for the 8 logic channels, indexed by channel number. */
export const CHANNEL_NAMES = ["D0", "D1", "D2", "D3", "D4", "D5", "D6", "D7"];
