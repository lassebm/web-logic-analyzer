import { describe, expect, it } from "vitest";
import {
  FakeSerialPort,
  metadataBytes,
  reversedDump,
  sumpResponses,
} from "../test/fakeSerial";
import { SerialConnection } from "./serialPort";
import {
  buildSampleLimits,
  buildSampleRates,
  identifySump,
  type SumpDevice,
} from "./device";
import {
  CMD_CAPTURE_DELAYCOUNT,
  CMD_CAPTURE_READCOUNT,
  CMD_CAPTURE_SIZE,
  CMD_RUN,
  CMD_SET_DIVIDER,
  CMD_SET_FLAGS,
  CMD_TRIGGER_CONFIG_0,
  CMD_TRIGGER_MASK_0,
  CMD_TRIGGER_VALUE_0,
} from "./protocol";
import type { AcquisitionRequest } from "../device/types";

async function connectTo(port: FakeSerialPort): Promise<SumpDevice> {
  const conn = new SerialConnection(port as unknown as SerialPort);
  await conn.open();
  return identifySump(conn);
}

function request(over: Partial<AcquisitionRequest> = {}): AcquisitionRequest {
  return {
    sampleRate: 1_000_000,
    sampleLimit: 16,
    trigger: { conditions: [] },
    ...over,
  };
}

/** Run one acquisition to completion and hand back what onData delivered. */
async function capture(
  dev: SumpDevice,
  req: AcquisitionRequest = request(),
): Promise<{ data: number[]; error: unknown }> {
  let data: number[] = [];
  let error: unknown = null;
  const acq = dev.acquire(req, {
    onData: (chunk) => (data = [...chunk]),
    onError: (err) => (error = err),
  });
  await acq.run();
  return { data, error };
}

describe("identifySump", () => {
  it("accepts a device that answers 1ALS and reads its metadata", async () => {
    const port = new FakeSerialPort({
      respond: sumpResponses(
        "ESP32-BP SUMP",
        [
          [0x20, 8],
          [0x21, 65_536],
          [0x23, 200_000_000],
        ],
        [],
      ),
    });
    const dev = await connectTo(port);
    expect(dev.metadata.name).toBe("ESP32-BP SUMP");
    expect(dev.label).toContain("ESP32-BP SUMP");
    expect(dev.capabilities.channels).toBe(8);
    // A one-shot dump: no Follow, no Serial Monitor.
    expect(dev.capabilities.streaming).toBe(false);
    expect(dev.capabilities.continuous).toBe(false);
  });

  it("accepts the byte-reversed 1SLO identity too", async () => {
    const port = new FakeSerialPort({
      respond: {
        0x02: new Uint8Array([0x31, 0x53, 0x4c, 0x4f]), // "1SLO"
        0x04: metadataBytes("Open Logic Sniffer v1.01"),
      },
    });
    const dev = await connectTo(port);
    expect(dev.profile.name).toBe("Open Logic Sniffer v1.01");
    expect(dev.profile.sampleMemory).toBe(24_576); // matched the OLS row
  });

  it("rejects a port that answers with something else", async () => {
    const port = new FakeSerialPort({
      respond: { 0x02: new Uint8Array([0x41, 0x42, 0x43, 0x44]) },
    });
    await expect(connectTo(port)).rejects.toThrow(/not a SUMP device/i);
  });

  it("rejects a port that says nothing at all", async () => {
    const port = new FakeSerialPort({});
    await expect(connectTo(port)).rejects.toThrow(/no reply/i);
  });

  // A device with no 0x04 support simply stays quiet; that must degrade to the
  // generic profile rather than hanging or failing the connect.
  it("falls back to the generic profile when metadata is silent", async () => {
    const port = new FakeSerialPort({
      respond: { 0x02: new Uint8Array([0x31, 0x41, 0x4c, 0x53]) },
    });
    const dev = await connectTo(port);
    expect(dev.profile.name).toBe("SUMP device");
    expect(dev.capabilities.sampleLimits).toEqual([1024, 4096]);
  });
});

describe("the dump direction", () => {
  // The single highest-risk defect in the whole driver: the device sends the
  // newest sample first, so a naive append yields a time-reversed waveform.
  it("un-reverses the dump into chronological order", async () => {
    const samples = [1, 2, 3, 4, 5, 6, 7, 8];
    const port = new FakeSerialPort({
      respond: sumpResponses("ESP32-BP SUMP", [[0x21, 4096]], samples),
    });
    const dev = await connectTo(port);
    const { data, error } = await capture(dev, request({ sampleLimit: 8 }));
    expect(error).toBeNull();
    expect(data).toEqual(samples);
  });

  it("reassembles a dump that arrives in several chunks", async () => {
    const samples = Array.from({ length: 64 }, (_, i) => i);
    const port = new FakeSerialPort({
      chunkSize: 7, // deliberately not a divisor of 64
      respond: sumpResponses("ESP32-BP SUMP", [[0x21, 4096]], samples),
    });
    const dev = await connectTo(port);
    const { data } = await capture(dev, request({ sampleLimit: 64 }));
    expect(data).toEqual(samples);
  });

  // Stopping mid-upload leaves the *newest* N samples, contiguous at the end of
  // the buffer — a shorter but still valid, still correctly-ordered capture.
  it("yields the newest-N tail when the dump ends early", async () => {
    const samples = [10, 11, 12, 13, 14, 15, 16, 17];
    const port = new FakeSerialPort({
      // Only the first half of the (reversed) dump ever arrives.
      respond: {
        0x02: new Uint8Array([0x31, 0x41, 0x4c, 0x53]),
        0x04: metadataBytes("ESP32-BP SUMP", [[0x21, 4096]]),
        [CMD_RUN]: reversedDump(samples).subarray(0, 4),
      },
    });
    const dev = await connectTo(port);
    const { data } = await capture(dev, request({ sampleLimit: 8 }));
    expect(data).toEqual([14, 15, 16, 17]);
  });

  // Stop has to reach into the wait, not just set a flag the loop checks between
  // reads: a device that is still filling its own memory (or waiting on a
  // trigger) says nothing for seconds or minutes, so a flag alone leaves the UI
  // sitting on "capturing…" with the Stop button apparently inert.
  it("gives up promptly when Stop is pressed on an armed device", async () => {
    const port = new FakeSerialPort({
      respond: {
        0x02: new Uint8Array([0x31, 0x41, 0x4c, 0x53]),
        0x04: metadataBytes("ESP32-BP SUMP", [[0x21, 4096]]),
      },
    });
    const dev = await connectTo(port);
    // The fake never answers CMD_RUN, so the read would otherwise sit on the
    // multi-second arm timeout.
    const acq = dev.acquire(request({ sampleLimit: 4 }), {
      onData: () => {},
      onError: () => {},
    });
    const run = acq.run();
    const t0 = Date.now();
    acq.stop();
    await run;
    expect(Date.now() - t0).toBeLessThan(1000);
  });

  it("tolerates Stop arriving after the run already finished", async () => {
    const samples = [1, 2, 3, 4, 5, 6, 7, 8];
    const port = new FakeSerialPort({
      chunkSize: 2,
      respond: {
        0x02: new Uint8Array([0x31, 0x41, 0x4c, 0x53]),
        0x04: metadataBytes("ESP32-BP SUMP", [[0x21, 4096]]),
        [CMD_RUN]: reversedDump(samples).subarray(0, 4),
      },
    });
    const dev = await connectTo(port);
    let data: number[] = [];
    const acq = dev.acquire(request({ sampleLimit: 8 }), {
      onData: (chunk) => (data = [...chunk]),
      onError: () => {},
    });
    await acq.run();
    acq.stop(); // a late Stop must not throw, nor disturb what was collected
    expect(data).toEqual([5, 6, 7, 8]); // the newest four of 1..8
  });
});

describe("the arm sequence", () => {
  async function armedCommands(
    req: AcquisitionRequest,
    name = "ESP32-BP SUMP",
    records: Array<[number, number]> = [[0x21, 4096]],
  ): Promise<{ port: FakeSerialPort; commands: number[] }> {
    const port = new FakeSerialPort({
      respond: sumpResponses(name, records, [1, 2, 3, 4]),
    });
    const dev = await connectTo(port);
    const before = port.commands.length;
    await capture(dev, req);
    return { port, commands: port.commands.slice(before) };
  }

  it("sends reset ×5, the trigger stage, divider, size, flags, then run", async () => {
    const { commands } = await armedCommands(request({ sampleLimit: 4 }));
    // Five resets open the exchange (a device may be mid-long-command).
    expect(commands.slice(0, 5)).toEqual([0, 0, 0, 0, 0]);
    const rest = commands.slice(5);
    expect(rest).toEqual([
      CMD_TRIGGER_MASK_0,
      CMD_TRIGGER_VALUE_0,
      CMD_TRIGGER_CONFIG_0,
      CMD_SET_DIVIDER,
      CMD_CAPTURE_SIZE,
      CMD_SET_FLAGS,
      CMD_RUN,
      // Teardown leaves the device idle rather than mid-upload.
      0,
      0,
      0,
      0,
      0,
    ]);
  });

  it("asks for channel group 0 only (flags 0x38)", async () => {
    const { port } = await armedCommands(request({ sampleLimit: 4 }));
    const at = port.written.lastIndexOf(CMD_SET_FLAGS);
    expect(port.written.slice(at + 1, at + 5)).toEqual([0x38, 0, 0, 0]);
  });

  it("sends the divider for the requested rate, little-endian", async () => {
    const { port } = await armedCommands(
      request({ sampleRate: 1_000_000, sampleLimit: 4 }),
    );
    const at = port.written.lastIndexOf(CMD_SET_DIVIDER);
    // 100 MHz / 1 MHz - 1 = 99.
    expect(port.written.slice(at + 1, at + 5)).toEqual([99, 0, 0, 0]);
  });

  // A device that doesn't implement 0x83/0x84 may not consume their payload
  // bytes and then stays desynced, so they must never be sent speculatively.
  it("never sends 0x83/0x84 to a device the 16-bit counts can cover", async () => {
    const { commands } = await armedCommands(
      request({ sampleLimit: 1_000_000 }), // more than 16-bit counts can hold
    );
    expect(commands).not.toContain(CMD_CAPTURE_READCOUNT);
    expect(commands).not.toContain(CMD_CAPTURE_DELAYCOUNT);
    expect(commands).toContain(CMD_CAPTURE_SIZE);
  });

  it("uses the 32-bit counts for a device too deep for the 16-bit ones", async () => {
    const { commands } = await armedCommands(
      request({ sampleLimit: 1_000_000 }),
      "Open Logic Sniffer v1.01",
      [[0x21, 4_000_000]], // past the 256 KiB threshold
    );
    expect(commands).toContain(CMD_CAPTURE_READCOUNT);
    expect(commands).toContain(CMD_CAPTURE_DELAYCOUNT);
    expect(commands).not.toContain(CMD_CAPTURE_SIZE);
  });

  it("drives the trigger unit only where the device has one", async () => {
    const trigger = { conditions: [{ channel: 2, edge: "high" as const }] };
    // ESP32-BP: no hardware trigger, so the stage must be a plain start.
    const noHw = await armedCommands(request({ sampleLimit: 4, trigger }));
    const noHwAt = noHw.port.written.lastIndexOf(CMD_TRIGGER_MASK_0);
    expect(noHw.port.written.slice(noHwAt + 1, noHwAt + 5)).toEqual([
      0, 0, 0, 0,
    ]);

    // OLS: the level condition goes to the hardware.
    const hw = await armedCommands(
      request({ sampleLimit: 4, trigger }),
      "Open Logic Sniffer v1.01",
    );
    const hwAt = hw.port.written.lastIndexOf(CMD_TRIGGER_MASK_0);
    expect(hw.port.written.slice(hwAt + 1, hwAt + 5)).toEqual([0b100, 0, 0, 0]);
  });
});

// An OLS-style core opens the window a sample after the one it fired on, so a
// brief level can be gone before sample 0 — searching the data would then mark
// the next occurrence, a different event from the one the device caught.
describe("the trigger position", () => {
  const high2 = { conditions: [{ channel: 2, edge: "high" as const }] };
  // D2 went high on the sample before the window and is already low again;
  // its next high is at index 2.
  const firedJustBefore = [0x00, 0x00, 0x04, 0x00];

  async function triggerReported(
    name: string,
    req: AcquisitionRequest,
    dump: Uint8Array = reversedDump(firedJustBefore),
  ): Promise<number[]> {
    const port = new FakeSerialPort({
      respond: {
        0x02: new Uint8Array([0x31, 0x41, 0x4c, 0x53]),
        0x04: metadataBytes(name, [[0x21, 4096]]),
        [CMD_RUN]: dump,
      },
    });
    const dev = await connectTo(port);
    const reported: number[] = [];
    await dev
      .acquire(req, {
        onData: () => {},
        onTrigger: (s) => reported.push(s),
      })
      .run();
    return reported;
  }

  it("reports a hardware trigger at sample 0, where the window opens", async () => {
    const at = await triggerReported(
      "Open Logic Sniffer v1.01",
      request({ sampleLimit: 4, trigger: high2 }),
    );
    expect(at).toEqual([0]);
  });

  it("reports nothing when the device was armed to start at once", async () => {
    // A device without a trigger unit, and an empty spec on one that has it.
    expect(
      await triggerReported(
        "ESP32-BP SUMP",
        request({ sampleLimit: 4, trigger: high2 }),
      ),
    ).toEqual([]);
    expect(
      await triggerReported(
        "Open Logic Sniffer v1.01",
        request({ sampleLimit: 4 }),
      ),
    ).toEqual([]);
  });

  it("reports nothing when a short dump has lost the trigger sample", async () => {
    // Newest first, so the half that arrives is the half *without* sample 0.
    const at = await triggerReported(
      "Open Logic Sniffer v1.01",
      request({ sampleLimit: 8, trigger: high2 }),
      reversedDump([0, 0, 0, 0, 4, 4, 4, 4]).subarray(0, 4),
    );
    expect(at).toEqual([]);
  });
});

describe("clamping the request", () => {
  // Asking for more than the device holds must shorten the expected byte count,
  // or the read waits forever for bytes that are never coming.
  it("clamps a request larger than the device's memory instead of hanging", async () => {
    const samples = Array.from({ length: 64 }, (_, i) => i + 1);
    const port = new FakeSerialPort({
      respond: sumpResponses("ESP32-BP SUMP", [[0x21, 64]], samples),
    });
    const dev = await connectTo(port);
    const { data, error } = await capture(
      dev,
      request({ sampleLimit: 1_000_000 }),
    );
    expect(error).toBeNull();
    expect(data).toHaveLength(64);
    expect(data).toEqual(samples);
  });
});

describe("buildSampleRates", () => {
  it("resolves every offered rate through the divider", () => {
    const rates = buildSampleRates(100_000_000, 100_000_000);
    expect(rates).toContain(100_000_000);
    expect(rates).toContain(1_000_000);
    expect(rates).toContain(10_000);
    expect([...rates].sort((a, b) => a - b)).toEqual(rates);
    expect(new Set(rates).size).toBe(rates.length); // deduped
  });

  // Rounding to the nearest divider would overshoot a ceiling like the
  // JTAGulator's 1.2 MSa/s, offering a rate the device can't reach.
  it("never offers a rate above the device's ceiling", () => {
    for (const max of [1_200_000, 4_000_000, 20_000_000, 62_500_000]) {
      const rates = buildSampleRates(100_000_000, max);
      expect(rates.length).toBeGreaterThan(0);
      expect(Math.max(...rates)).toBeLessThanOrEqual(max);
    }
  });

  it("offers the ceiling itself, not just the nice value below it", () => {
    const rates = buildSampleRates(100_000_000, 1_200_000);
    // 100 MHz / 84 = 1,190,476 — the closest the divider gets to 1.2 MSa/s.
    expect(Math.max(...rates)).toBe(1_190_476);
  });
});

describe("buildSampleLimits", () => {
  it("caps at the device's memory and always offers it", () => {
    expect(buildSampleLimits(4096, false)).toEqual([1024, 4096]);
    expect(buildSampleLimits(24_576, true)).toEqual([
      1024, 4096, 16_384, 24_576,
    ]);
    expect(buildSampleLimits(131_072, false)).toEqual([
      1024, 4096, 16_384, 65_536, 131_072,
    ]);
  });

  it("rounds a memory size down to the protocol's 4-sample granularity", () => {
    expect(buildSampleLimits(4095, false)).toEqual([1024, 4092]);
  });

  it("caps a deep device without 32-bit counts at what 0x81 can express", () => {
    expect(Math.max(...buildSampleLimits(4_000_000, false))).toBe(262_144);
    expect(Math.max(...buildSampleLimits(4_000_000, true))).toBe(4_000_000);
  });

  it("copes with a device smaller than the smallest step", () => {
    expect(buildSampleLimits(532, false)).toEqual([532]);
  });
});
