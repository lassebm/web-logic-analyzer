// SUMP/OLS backend: a serial port, identified by the protocol rather than by
// USB ids. Web Serial has no equivalent of a device filter that could tell a
// logic analyzer from any other USB-serial adapter, so the chooser offers every
// port and `identifySump()` is what decides.

import { SerialConnection } from "../sump/serialPort";
import { identifySump, SumpDevice, buildSampleRates } from "../sump/device";
import { GENERIC_PROFILE, SUMP_CLOCK_HZ } from "../sump/profiles";
import type {
  ConnectContext,
  ConnectResult,
  DeviceBackend,
  DeviceCapabilities,
  LogicDevice,
} from "./types";

/** What the toolbar offers before a device is connected: the shared 100 MHz
 *  divider clock, and the flags that gate Follow and the Serial Monitor — those
 *  are true of every SUMP device, so they don't wait for a connection. */
export const SUMP_DEFAULT_CAPABILITIES: DeviceCapabilities = {
  channels: GENERIC_PROFILE.channels,
  sampleRates: buildSampleRates(SUMP_CLOCK_HZ, GENERIC_PROFILE.maxSampleRate),
  sampleLimits: [1024, 4096],
  hardwareTrigger: false,
  streaming: false,
  continuous: false,
};

class SumpBackend implements DeviceBackend {
  readonly id = "sump" as const;
  readonly name = "SUMP/OLS (serial)";
  readonly defaultCapabilities = SUMP_DEFAULT_CAPABILITIES;
  readonly unsupportedMessage =
    "Web Serial is not available. Use Chrome, Edge, or another Chromium browser.";

  private readonly live = new Set<SumpDevice>();
  private disconnectTarget: Serial | null = null;

  isSupported(): boolean {
    return SerialConnection.isSupported();
  }

  async connect(ctx: ConnectContext): Promise<ConnectResult> {
    ctx.status("Requesting serial port…");
    return this.provision(await SerialConnection.request(), ctx);
  }

  /**
   * No silent reconnect. Opening a serial port asserts DTR, which reboots any
   * board with the usual auto-reset circuit (most ESP32 and Arduino ones) — and
   * unlike WebUSB there is nothing in a granted port that says whether it is
   * even a logic analyzer, so a page reload would poke unrelated hardware and
   * reset the user's device for nothing. Connecting stays an explicit click.
   */
  async reconnect(): Promise<ConnectResult> {
    return { kind: "none" };
  }

  watchDisconnect(onLost: (dev: LogicDevice) => void): void {
    const serial = navigator.serial;
    if (!serial || typeof serial.addEventListener !== "function") return;
    if (this.disconnectTarget === serial) return;
    this.disconnectTarget = serial;
    serial.addEventListener("disconnect", ((event: { target?: unknown }) => {
      for (const dev of this.live) {
        if (dev.conn.port === event.target) {
          this.live.delete(dev);
          onLost(dev);
        }
      }
    }) as EventListener);
  }

  private async provision(
    conn: SerialConnection,
    ctx: ConnectContext,
  ): Promise<ConnectResult> {
    ctx.status("Opening serial port…");
    await conn.open();
    try {
      ctx.status("Identifying device…");
      const dev = await identifySump(conn, (d) => this.live.delete(d));
      this.live.add(dev);
      return { kind: "device", device: dev };
    } catch (err) {
      // A port we opened but couldn't identify has to be released, or the next
      // attempt fails with "port already open" rather than the real reason.
      await conn.close();
      throw err;
    }
  }
}

export const sumpBackend: DeviceBackend = new SumpBackend();
