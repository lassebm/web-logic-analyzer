import { describe, expect, it } from "vitest";
import { CaptureSession, getFirmwareVersion, getRevId } from "./capture";
import { CMD_START } from "./constants";
import { encodeSampleRate } from "./sampleRate";
import { Fx2Device } from "./fx2Device";
import { FakeUSBDevice } from "../test/fakeUsb";

// Two fake seams appear here deliberately:
// - CaptureSession tests use small inline fakes of the *Fx2Device* interface,
//   because the abort scenario needs a readBulk() that never resolves until
//   reset() rejects it — something the shared USBDevice fake cannot express.
// - The version/REVID control transfers use the shared FakeUSBDevice wrapped in
//   a real Fx2Device, exercising the actual control-transfer path.

/** Fake device whose bulk reads never resolve until reset() aborts them all. */
function makeBlockingDevice() {
  const rejects: Array<(e: unknown) => void> = [];
  return {
    claimCalls: 0,
    resetCalls: 0,
    async claim() {
      this.claimCalls++;
    },
    async controlOut() {},
    readBulk(): Promise<USBInTransferResult> {
      return new Promise((_resolve, reject) => {
        rejects.push(reject);
      });
    },
    async reset() {
      this.resetCalls++;
      while (rejects.length) rejects.pop()?.(new Error("aborted by reset"));
    },
  };
}

/** Fake device that fails the given prologue step. */
function makeFailingDevice(failAt: "claim" | "controlOut") {
  return {
    started: false,
    async claim() {
      if (failAt === "claim") throw new Error("claim failed");
    },
    async controlOut() {
      if (failAt === "controlOut") throw new Error("start stalled");
      this.started = true;
    },
    async readBulk(): Promise<USBInTransferResult> {
      return { status: "ok", data: new DataView(new Uint8Array(8).buffer) };
    },
    async reset() {},
  };
}

/** Fake device that streams fixed-size chunks instantly. */
function makeStreamingDevice(chunkSize: number) {
  return {
    resetCalls: 0,
    async claim() {},
    async controlOut() {},
    async readBulk(): Promise<USBInTransferResult> {
      return {
        status: "ok",
        data: new DataView(new Uint8Array(chunkSize).buffer),
      } as USBInTransferResult;
    },
    async reset() {
      this.resetCalls++;
    },
  };
}

/** Fake device that always returns an 'ok' but zero-length bulk result. */
function makeIdleDevice() {
  return {
    resetCalls: 0,
    async claim() {},
    async controlOut() {},
    async readBulk(): Promise<USBInTransferResult> {
      return {
        status: "ok",
        data: new DataView(new Uint8Array(0).buffer),
      } as USBInTransferResult;
    },
    async reset() {
      this.resetCalls++;
    },
  };
}

describe("CaptureSession", () => {
  it("stop() aborts an in-flight transfer and resolves run()", async () => {
    const dev = makeBlockingDevice();
    const session = new CaptureSession(
      dev as unknown as Fx2Device,
      {
        sampleRate: 1_000_000,
        sampleLimit: 1e9,
        transferSize: 1024,
      },
      { onData: () => {} },
    );

    const running = session.run();
    await new Promise((r) => setTimeout(r, 0)); // reach the awaited readBulk
    session.stop();
    await running; // must not hang

    expect(dev.resetCalls).toBe(1);
  });

  // A prologue failure used to reject run() instead of reaching onError, which
  // stranded the caller on "capturing" forever with no message.
  it.each(["claim", "controlOut"] as const)(
    "reports a failing %s through onError instead of rejecting",
    async (failAt) => {
      const dev = makeFailingDevice(failAt);
      const errors: unknown[] = [];
      const session = new CaptureSession(
        dev as unknown as Fx2Device,
        { sampleRate: 1_000_000, sampleLimit: 100, transferSize: 64 },
        { onData: () => {}, onError: (e) => errors.push(e) },
      );

      await expect(session.run()).resolves.toBeUndefined();
      expect(errors).toHaveLength(1);
      expect((errors[0] as Error).message).toMatch(
        failAt === "claim" ? /claim failed/ : /start stalled/,
      );
    },
  );

  it("sends CMD_START with the encoded clock divider before streaming", async () => {
    const sent: Array<{ req: number; data: number[] }> = [];
    const dev = {
      async claim() {},
      async controlOut(req: number, _val: number, data: Uint8Array) {
        sent.push({ req, data: [...data] });
      },
      async readBulk(): Promise<USBInTransferResult> {
        return { status: "ok", data: new DataView(new Uint8Array(50).buffer) };
      },
      async reset() {},
    };
    const session = new CaptureSession(
      dev as unknown as Fx2Device,
      { sampleRate: 1_000_000, sampleLimit: 50, transferSize: 64 },
      { onData: () => {} },
    );
    await session.run();

    const { flags, sampleDelayH, sampleDelayL } = encodeSampleRate(1_000_000);
    expect(sent).toEqual([
      { req: CMD_START, data: [flags, sampleDelayH, sampleDelayL] },
    ]);
  });

  it("stops at the sample limit and resets once", async () => {
    const dev = makeStreamingDevice(1000);
    const chunks: number[] = [];
    const session = new CaptureSession(
      dev as unknown as Fx2Device,
      {
        sampleRate: 1_000_000,
        sampleLimit: 2500,
        transferSize: 1000,
      },
      { onData: (c) => chunks.push(c.length) },
    );

    await session.run();

    expect(chunks.reduce((a, b) => a + b, 0)).toBe(2500); // last chunk truncated
    expect(dev.resetCalls).toBe(1);
  });

  it("aborts instead of looping forever when the device streams no data", async () => {
    const dev = makeIdleDevice();
    let error: unknown;
    const session = new CaptureSession(
      dev as unknown as Fx2Device,
      {
        sampleRate: 1_000_000,
        sampleLimit: 1e9,
        transferSize: 512,
        transferDepth: 2,
      },
      { onData: () => {}, onError: (e) => (error = e) },
    );

    await session.run(); // must not hang

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/no sample data/i);
    expect(dev.resetCalls).toBe(1);
  });
});

describe("getFirmwareVersion", () => {
  const wrap = (opts?: ConstructorParameters<typeof FakeUSBDevice>[0]) =>
    new Fx2Device(new FakeUSBDevice(opts) as unknown as USBDevice);

  it("returns the running firmware version", async () => {
    await expect(
      getFirmwareVersion(wrap({ firmwareVersion: [1, 3] })),
    ).resolves.toEqual({
      major: 1,
      minor: 3,
    });
  });

  it("throws when the major version is unsupported", async () => {
    await expect(
      getFirmwareVersion(wrap({ firmwareVersion: [2, 0] })),
    ).rejects.toThrow(/Unsupported fx2lafw firmware version 2\.0/);
  });

  it("throws on a malformed (too-short) firmware-version response", async () => {
    await expect(
      getFirmwareVersion(
        wrap({
          onControlIn: (req) =>
            req === 0xb0 ? new Uint8Array([1]) : undefined,
        }),
      ),
    ).rejects.toThrow(/malformed firmware-version/i);
  });
});

describe("getRevId", () => {
  it("returns the REVID byte", async () => {
    const dev = new Fx2Device(
      new FakeUSBDevice({ revid: 7 }) as unknown as USBDevice,
    );
    await expect(getRevId(dev)).resolves.toBe(7);
  });

  it("throws on an empty rev-id response", async () => {
    const dev = new Fx2Device(
      new FakeUSBDevice({
        onControlIn: (req) => (req === 0xb2 ? new Uint8Array(0) : undefined),
      }) as unknown as USBDevice,
    );
    await expect(getRevId(dev)).rejects.toThrow(/malformed rev-id/i);
  });
});
