// Thin Web Serial wrapper — the analogue of usb/fx2Device.ts. Keeps every
// `navigator.serial` / stream detail in one place so sump/device.ts reads as
// protocol, not plumbing.

/** 115200/8N1 is what every SUMP compatible speaks. Driver-level flow control
 *  must stay off: 0x11/0x13 (XON/XOFF) occur freely inside sample data, so a
 *  driver acting on them would silently eat bytes and stall the dump. */
const SERIAL_OPTIONS: SerialOptions = {
  baudRate: 115200,
  dataBits: 8,
  stopBits: 1,
  parity: "none",
  flowControl: "none",
  // A whole dump can arrive faster than we drain it; a big read buffer keeps the
  // browser from dropping bytes while the main thread is busy.
  bufferSize: 262_144,
};

export class SerialConnection {
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
  /** A read raced past its timeout stays pending; keep it so the next call
   *  picks up the bytes instead of losing them. */
  private pending: Promise<ReadableStreamReadResult<Uint8Array>> | null = null;
  /** Cuts short the wait in `read()`, without disturbing the stream itself. */
  private wake: (() => void) | null = null;

  constructor(readonly port: SerialPort) {}

  static isSupported(): boolean {
    return typeof navigator !== "undefined" && "serial" in navigator;
  }

  /** Prompt the user to pick a port. No filters: SUMP devices sit behind every
   *  kind of USB-serial bridge, and several are native CDC with no fixed VID. */
  static async request(): Promise<SerialConnection> {
    if (!SerialConnection.isSupported())
      throw new Error("Web Serial is not available in this browser.");
    const port = await navigator.serial.requestPort({});
    return new SerialConnection(port);
  }

  async open(): Promise<void> {
    await this.port.open(SERIAL_OPTIONS);
    this.reader = this.port.readable?.getReader() ?? null;
    this.writer = this.port.writable?.getWriter() ?? null;
    if (!this.reader || !this.writer) {
      throw new Error("Serial port opened without readable/writable streams.");
    }
    // Some boards hold the MCU in reset until DTR is asserted, and some
    // driver/browser combinations don't expose signals at all — hence the
    // best-effort try/catch rather than a hard requirement.
    try {
      await this.port.setSignals({
        dataTerminalReady: true,
        requestToSend: false,
      });
    } catch {
      /* signals unavailable on this platform */
    }
  }

  async write(bytes: Uint8Array): Promise<void> {
    if (!this.writer) throw new Error("Serial port is not open.");
    await this.writer.write(bytes);
  }

  /**
   * Read whatever has arrived, or null after `timeoutMs` of silence. A null is
   * "nothing yet", never "closed" — the caller decides what silence means,
   * because for SUMP it means different things before and during a dump.
   */
  async read(timeoutMs: number): Promise<Uint8Array | null> {
    if (!this.reader) throw new Error("Serial port is not open.");
    const pending = (this.pending ??= this.reader.read());
    let timer: ReturnType<typeof setTimeout> | undefined;
    const TIMED_OUT = Symbol("idle");
    try {
      const settled = await Promise.race([
        pending,
        new Promise<typeof TIMED_OUT>((resolve) => {
          timer = setTimeout(() => resolve(TIMED_OUT), timeoutMs);
          this.wake = () => resolve(TIMED_OUT);
        }),
      ]);
      if (settled === TIMED_OUT) return null; // `pending` stays for next time
      this.pending = null;
      return settled.done ? null : (settled.value ?? null);
    } finally {
      clearTimeout(timer);
      this.wake = null;
    }
  }

  /**
   * End the read in flight now, as if it had gone idle. The device is under no
   * obligation to say anything — an armed capture can wait minutes for its
   * trigger — so Stop has to be able to reach into the wait itself rather than
   * setting a flag the loop only sees once the read returns.
   */
  interrupt(): void {
    this.wake?.();
  }

  /** Discard anything already buffered, so the next reply is unambiguous. */
  async drain(idleMs = 30): Promise<void> {
    while ((await this.read(idleMs)) !== null) {
      /* keep discarding */
    }
  }

  async close(): Promise<void> {
    this.interrupt(); // let any parked read() give up before we tear down
    try {
      // Cancel first: a reader with a pending read holds the lock, and
      // port.close() would reject while it does.
      await this.reader?.cancel();
    } catch {
      /* already gone */
    }
    this.pending = null;
    try {
      this.reader?.releaseLock();
      this.writer?.releaseLock();
    } catch {
      /* already released */
    }
    this.reader = null;
    this.writer = null;
    try {
      await this.port.close();
    } catch {
      /* port may be mid-teardown */
    }
  }
}
