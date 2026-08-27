// Shared Web Serial test doubles, mirroring fakeUsb.ts. `SerialConnection`
// (src/sump/serialPort.ts) wraps a `SerialPort` and the SUMP driver reaches the
// browser only through `navigator.serial`, so these fakes drive the whole serial
// stack under Node — no hardware, no browser.
//
// The port is scripted per *command*: `respond` maps an opcode to the bytes the
// device sends back, which is exactly how a SUMP exchange reads (ID → 4 bytes,
// metadata → a TLV blob, run → a reversed dump). Anything not in the map is
// silently consumed, like a real device ignoring an opcode it doesn't know.

import { CMD_ID, CMD_METADATA, CMD_RUN, CMD_RESET } from "../sump/protocol";

/** A device -> host reply: either fixed bytes or a lazily-built stream. */
export type Reply = Uint8Array | (() => Uint8Array | null);

export interface FakeSerialPortOptions {
  /** Opcode -> reply. Long commands' payload bytes are consumed automatically. */
  respond?: Record<number, Reply>;
  /** Chunk size the reader hands out, to exercise multi-chunk assembly. */
  chunkSize?: number;
}

/** Minimal in-memory stand-in for a Web Serial SerialPort. */
export class FakeSerialPort {
  /** Every byte the host wrote, in order — the arm sequence, for assertions. */
  readonly written: number[] = [];
  /** Opcodes recognised as commands, in order. */
  readonly commands: number[] = [];
  private outbox: number[] = [];
  private waiting: Array<
    (value: ReadableStreamReadResult<Uint8Array>) => void
  > = [];
  private cancelled = false;
  /** Payload bytes still to swallow from the long command in progress. */
  private pendingPayload = 0;
  private readonly chunkSize: number;

  readable: ReadableStream<Uint8Array> | null = null;
  writable: WritableStream<Uint8Array> | null = null;

  constructor(private readonly opts: FakeSerialPortOptions = {}) {
    this.chunkSize = opts.chunkSize ?? 4096;
  }

  async open(_options: SerialOptions): Promise<void> {
    this.cancelled = false;
    this.readable = this.makeReadable();
    this.writable = this.makeWritable();
  }

  async close(): Promise<void> {
    this.readable = null;
    this.writable = null;
  }

  async setSignals(): Promise<void> {}

  addEventListener(): void {}
  removeEventListener(): void {}

  /** Queue bytes for the host to read, as if the device had sent them. */
  send(bytes: Uint8Array): void {
    for (const b of bytes) this.outbox.push(b);
    this.flush();
  }

  /** Every opcode >= 0x80 carries 4 payload bytes. */
  private isLong(op: number): boolean {
    return op >= 0x80;
  }

  private handleByte(byte: number): void {
    this.written.push(byte);
    if (this.pendingPayload > 0) {
      this.pendingPayload--;
      return;
    }
    this.commands.push(byte);
    if (this.isLong(byte)) this.pendingPayload = 4;
    if (byte === CMD_RESET) {
      // A reset drops anything the device was about to send, as a real one does.
      this.outbox = [];
      return;
    }
    const reply = this.opts.respond?.[byte];
    if (!reply) return;
    const bytes = typeof reply === "function" ? reply() : reply;
    if (bytes) this.send(bytes);
  }

  private flush(): void {
    while (this.waiting.length > 0 && this.outbox.length > 0) {
      const take = this.outbox.splice(0, this.chunkSize);
      this.waiting.shift()?.({
        value: new Uint8Array(take),
        done: false,
      });
    }
  }

  private makeReadable(): ReadableStream<Uint8Array> {
    // Hand-rolled rather than a real ReadableStream so a read can be left
    // pending indefinitely and resolved later by send() or cancel(). Arrow
    // methods keep `this` bound to the port.
    const reader = {
      read: async (): Promise<ReadableStreamReadResult<Uint8Array>> => {
        if (this.cancelled) return { value: undefined, done: true };
        if (this.outbox.length > 0) {
          return {
            value: new Uint8Array(this.outbox.splice(0, this.chunkSize)),
            done: false,
          };
        }
        // Nothing buffered: park until something is sent or the read is
        // cancelled — a real port simply stays quiet. Every caller passes a
        // timeout, so this is also how an armed-but-untriggered device behaves.
        return new Promise((resolve) => this.waiting.push(resolve));
      },
      cancel: async (): Promise<void> => {
        this.cancelled = true;
        while (this.waiting.length)
          this.waiting.shift()?.({ value: undefined, done: true });
      },
      releaseLock: (): void => {},
      closed: Promise.resolve(undefined),
    } as unknown as ReadableStreamDefaultReader<Uint8Array>;

    return {
      getReader: () => reader,
    } as unknown as ReadableStream<Uint8Array>;
  }

  private makeWritable(): WritableStream<Uint8Array> {
    const writer = {
      write: async (bytes: Uint8Array): Promise<void> => {
        for (const b of bytes) this.handleByte(b);
      },
      releaseLock: (): void => {},
      close: async (): Promise<void> => {},
    } as unknown as WritableStreamDefaultWriter<Uint8Array>;
    return {
      getWriter: () => writer,
    } as unknown as WritableStream<Uint8Array>;
  }
}

/** SUMP metadata bytes: a name string plus big-endian u32 records. */
export function metadataBytes(
  name: string,
  records: Array<[key: number, value: number]> = [],
): Uint8Array {
  const out: number[] = [0x01];
  for (const ch of name) out.push(ch.charCodeAt(0));
  out.push(0x00);
  for (const [key, value] of records) {
    out.push(key);
    out.push((value >>> 24) & 0xff, (value >>> 16) & 0xff);
    out.push((value >>> 8) & 0xff, value & 0xff);
  }
  out.push(0x00); // terminator
  return new Uint8Array(out);
}

/** A SUMP dump of `samples` as the device sends it: newest sample first. */
export function reversedDump(samples: number[]): Uint8Array {
  return new Uint8Array([...samples].reverse());
}

/** The standard reply set for a device that identifies and dumps `samples`. */
export function sumpResponses(
  name: string,
  records: Array<[number, number]>,
  samples: number[],
): Record<number, Reply> {
  return {
    [CMD_ID]: new Uint8Array([0x31, 0x41, 0x4c, 0x53]), // "1ALS"
    [CMD_METADATA]: metadataBytes(name, records),
    [CMD_RUN]: reversedDump(samples),
  };
}

export interface FakeNavigatorSerialHandle {
  /** Fire a `disconnect` event for the given port. */
  emitDisconnect(port?: FakeSerialPort): void;
  restore(): void;
}

export interface InstallSerialOptions {
  /** Port handed back by requestPort(). */
  requestPort?: FakeSerialPort;
}

/**
 * Install a fake `navigator.serial`. Returns a handle to drive disconnects and
 * to restore the original. Creates `globalThis.navigator` if absent (Node env).
 */
export function installFakeNavigatorSerial(
  opts: InstallSerialOptions = {},
): FakeNavigatorSerialHandle {
  const listeners = new Map<string, Set<(ev: unknown) => void>>();

  const serial = {
    async requestPort(): Promise<SerialPort> {
      if (!opts.requestPort) throw new Error("No port selected");
      return opts.requestPort as unknown as SerialPort;
    },
    addEventListener(type: string, cb: (ev: unknown) => void): void {
      (listeners.get(type) ?? listeners.set(type, new Set()).get(type)!).add(
        cb,
      );
    },
    removeEventListener(type: string, cb: (ev: unknown) => void): void {
      listeners.get(type)?.delete(cb);
    },
  };

  const nav = (globalThis as { navigator?: Navigator }).navigator;
  const had = nav && "serial" in nav;
  const prev = had ? (nav as unknown as { serial: unknown }).serial : undefined;
  if (!nav) {
    (globalThis as { navigator?: unknown }).navigator = { serial };
  } else {
    Object.defineProperty(nav, "serial", {
      value: serial,
      configurable: true,
      writable: true,
    });
  }

  return {
    emitDisconnect(port?: FakeSerialPort) {
      for (const cb of listeners.get("disconnect") ?? []) cb({ target: port });
    },
    restore() {
      const n = (globalThis as { navigator?: Navigator }).navigator;
      if (!n) return;
      if (had)
        Object.defineProperty(n, "serial", {
          value: prev,
          configurable: true,
          writable: true,
        });
      else delete (n as unknown as { serial?: unknown }).serial;
    },
  };
}
