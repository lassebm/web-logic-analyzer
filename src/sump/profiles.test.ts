import { describe, expect, it } from "vitest";
import {
  GENERIC_PROFILE,
  SUMP_CLOCK_HZ,
  WIDE_COUNT_MEMORY_THRESHOLD,
  resolveProfile,
} from "./profiles";

describe("resolveProfile", () => {
  it("falls back to the generic profile when 0x04 said nothing", () => {
    const resolved = resolveProfile({});
    expect(resolved).toEqual(GENERIC_PROFILE);
  });

  it("lets metadata fill in the numbers for a device with no profile row", () => {
    const resolved = resolveProfile({
      name: "Some Other Sniffer",
      probes: 4,
      sampleMemory: 8192,
      maxSampleRate: 12_000_000,
    });
    expect(resolved.channels).toBe(4);
    expect(resolved.sampleMemory).toBe(8192);
    expect(resolved.maxSampleRate).toBe(12_000_000);
  });

  // A profile row fills in gaps; it never overrides what the device reports.
  // ESP32-BP's memory is heap-dependent, so its own number has to win.
  it("prefers metadata over the matched profile's own fallbacks", () => {
    const resolved = resolveProfile({
      name: "ESP32-BP SUMP",
      probes: 8,
      sampleMemory: 40_000,
    });
    expect(resolved.sampleMemory).toBe(40_000);
    expect(resolved.hardwareTrigger).toBe(false); // from the profile
  });

  // The clock is a hard ceiling: a divider can only divide. Both the OLS and
  // ESP32-BP advertise 200 MHz while dividing libsigrok's shared 100 MHz.
  it("caps the max rate at the base clock, whatever the device claims", () => {
    expect(
      resolveProfile({ name: "ESP32-BP SUMP", maxSampleRate: 200_000_000 })
        .maxSampleRate,
    ).toBe(SUMP_CLOCK_HZ);
    expect(
      resolveProfile({
        name: "Open Logic Sniffer v1.01",
        maxSampleRate: 200_000_000,
      }).maxSampleRate,
    ).toBe(SUMP_CLOCK_HZ);
  });

  it("keeps the OLS's 24 KiB depth and hardware trigger", () => {
    const resolved = resolveProfile({ name: "Open Logic Sniffer v1.01" });
    expect(resolved.sampleMemory).toBe(24_576);
    expect(resolved.hardwareTrigger).toBe(true);
  });

  // The Logic Shrimp's firmware doesn't publish metadata matching its hardware.
  // libsigrok supplies exactly these three values, and only where the device
  // said nothing — so this row fills gaps rather than overriding.
  it("fills in the Logic Shrimp's missing metadata", () => {
    const resolved = resolveProfile({ name: "Logic Shrimp" });
    expect(resolved.channels).toBe(4);
    expect(resolved.sampleMemory).toBe(262_144);
    expect(resolved.maxSampleRate).toBe(20_000_000);
  });

  it("still lets the Logic Shrimp's own metadata win where it reports some", () => {
    const resolved = resolveProfile({ name: "Logic Shrimp", probes: 8 });
    expect(resolved.channels).toBe(8);
    expect(resolved.sampleMemory).toBe(262_144); // still filled in
  });

  it("gives the Bus Pirate 5 its documented depth and rate ceiling", () => {
    const resolved = resolveProfile({ name: "Bus Pirate 5" });
    expect(resolved.sampleMemory).toBe(131_072);
    expect(resolved.maxSampleRate).toBe(62_500_000);
  });

  it("caps channels at what the app can render, however many the device has", () => {
    expect(resolveProfile({ name: "JTAGulator", probes: 24 }).channels).toBe(8);
  });

  it("distinguishes a Bus Pirate 5 from a v3 by name", () => {
    expect(resolveProfile({ name: "Bus Pirate 5" }).channels).toBe(8);
    expect(resolveProfile({ name: "Bus Pirate v3.6" }).channels).toBe(5);
  });

  // Firmware that omits a value by writing 0 rather than skipping the key would
  // otherwise resolve to a device with no channels, or a 1 Hz rate list.
  it("treats a reported zero as 'didn't say', not as a real value", () => {
    const resolved = resolveProfile({
      name: "Odd Sniffer",
      probes: 0,
      sampleMemory: 0,
      maxSampleRate: 0,
    });
    expect(resolved).toEqual({ ...GENERIC_PROFILE, name: "Odd Sniffer" });
  });
});

describe("wideCounts", () => {
  // Reported memory is the only input — libsigrok's rule, with no per-device
  // exceptions, because nothing at or below the threshold could reach the 32-bit
  // path anyway (the 16-bit command covers up to 262144 samples).
  it("follows the memory threshold, for every device", () => {
    for (const name of [
      "Open Logic Sniffer v1.01",
      "Bus Pirate 5",
      "ESP32-BP SUMP",
      "Totally Unknown Board",
    ]) {
      expect(resolveProfile({ name, sampleMemory: 1 << 20 }).wideCounts).toBe(
        true,
      );
      expect(
        resolveProfile({ name, sampleMemory: WIDE_COUNT_MEMORY_THRESHOLD })
          .wideCounts,
      ).toBe(false);
    }
  });

  it("is off for every profiled device at its own documented depth", () => {
    for (const name of [
      "Open Logic Sniffer v1.01",
      "Bus Pirate 5",
      "Bus Pirate v3.6",
      "Logic Shrimp",
      "JTAGulator",
      "AGLA",
      "ESP32-BP SUMP",
    ]) {
      expect(resolveProfile({ name }).wideCounts).toBe(false);
    }
  });
});

describe("name matching", () => {
  it("falls back to the generic profile for a missing or unknown name", () => {
    expect(resolveProfile({}).name).toBe(GENERIC_PROFILE.name);
    expect(resolveProfile({ name: "Totally Unknown Board" }).sampleMemory).toBe(
      GENERIC_PROFILE.sampleMemory,
    );
  });

  it("matches case-insensitively", () => {
    expect(
      resolveProfile({ name: "open logic sniffer v1.01" }).sampleMemory,
    ).toBe(24_576);
  });
});
