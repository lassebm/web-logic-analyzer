// SUMP/OLS device emulator for ESP32-C3 / S3 / classic ESP32.
//
// A bench target for the app's SUMP backend when you have no SUMP hardware. It
// speaks the protocol over USB CDC (or UART0 on boards without native USB) and,
// instead of sampling pins, *synthesizes* the same signals as the app's built-in
// demo capture (src/demo/capture.ts): UART on D0, SPI on D1-D3, I2C on D4/D5,
// 1-Wire on D6, CAN on D7.
//
// Synthesizing is the point. The pattern (tools/common/demo_pattern.h, shared
// with the FX2 emulator) is generated from timings in microseconds and
// converted with whatever sample rate the host asked for, so every protocol keeps
// its real-world bit rate at any rate the host picks. That makes the whole path
// self-checking:
//
//   * if the host reverses the dump, the decoders find nothing;
//   * if the host mislabels the divider-resolved rate, the UART decodes at the
//     wrong baud and the CAN frames come out at the wrong bit rate;
//   * if the host forgets the 0x82 flags byte, the sample stream desynchronizes.
//
// It also reproduces ESP32-Bit-Pirate's quirks on purpose — see PERSONA below.
//
// Build: pio run -e c3 -t upload   (see platformio.ini for the other personas)

#include <Arduino.h>

#include "../../common/demo_pattern.h"

// --- Persona -----------------------------------------------------------------
// Which device this pretends to be. Set from platformio.ini build_flags; the
// names are chosen to match the app's own profile rows (src/sump/profiles.ts).

#ifndef DEV_NAME
// Board-neutral default; the per-board envs name themselves. All of these match
// the app's /esp32/i profile row.
#define DEV_NAME "ESP32 SUMP emulator"
#endif
#ifndef DEV_FIRMWARE
#define DEV_FIRMWARE "synth-demo"
#endif
// 262144 samples is exactly what the 16-bit CMD_CAPTURE_SIZE can express, so a
// host that respects the protocol never needs 0x83/0x84 to drive us.
#ifndef DEV_MEMORY
#define DEV_MEMORY 262144UL
#endif
#ifndef DEV_MAX_RATE
#define DEV_MAX_RATE 100000000UL
#endif
// 1 = honour the basic trigger (scan the pattern for the level condition and
// start the capture there). 0 = consume the trigger commands and ignore them,
// as ESP32-Bit-Pirate does.
#ifndef DEV_HW_TRIGGER
#define DEV_HW_TRIGGER 0
#endif
// 0 = answer 0x04 with nothing at all, so the host falls back to its generic
// profile. Useful for testing that path.
#ifndef DEV_SEND_METADATA
#define DEV_SEND_METADATA 1
#endif
// 1 = reproduce ESP32-Bit-Pirate's bug: an unknown opcode >= 0x80 is dropped
// *without* consuming its 4 payload bytes, which then get read as opcodes. A
// well-behaved host never sends us an unknown long command, so this should make
// no difference — that is exactly what it is here to prove. Set to 0 for a
// spec-correct device.
#ifndef DEV_BUGGY_LONG_CMDS
#define DEV_BUGGY_LONG_CMDS 1
#endif
// 1 = implement the 32-bit count commands (0x84/0x83). Only reachable when the
// reported memory is over 256 KiB, since below that the 16-bit CMD_CAPTURE_SIZE
// expresses every count a host could ask for.
#ifndef DEV_WIDE_COUNTS
#define DEV_WIDE_COUNTS 0
#endif

// --- Protocol ----------------------------------------------------------------

static const uint8_t CMD_RESET = 0x00;
static const uint8_t CMD_RUN = 0x01;
static const uint8_t CMD_ID = 0x02;
static const uint8_t CMD_METADATA = 0x04;
static const uint8_t CMD_XON = 0x11;
static const uint8_t CMD_XOFF = 0x13;
static const uint8_t CMD_SET_DIVIDER = 0x80;
static const uint8_t CMD_CAPTURE_SIZE = 0x81;
static const uint8_t CMD_SET_FLAGS = 0x82;
static const uint8_t CMD_CAPTURE_DELAYCOUNT = 0x83;
static const uint8_t CMD_CAPTURE_READCOUNT = 0x84;
static const uint8_t CMD_TRIGGER_FIRST = 0xc0;
static const uint8_t CMD_TRIGGER_LAST = 0xcf;

/** The divider divides this, on every SUMP device (libsigrok's CLOCK_RATE). */
static const uint32_t CLOCK_HZ = 100000000UL;

/** Ceiling on the synthesized pattern, so a high rate can't exhaust the heap.
 *  Beyond this the demo cycle is truncated, not refused. */
static const uint32_t PATTERN_CAP = 96 * 1024;

/** Longest we pretend a capture took before starting the upload. Real devices
 *  fill their memory first; emulating that exercises the host's rate-aware wait
 *  for the first byte, but an unbounded wait at 20 kHz would just be tedious. */
static const uint32_t MAX_FAKE_CAPTURE_MS = 10000;

static uint32_t divider = 99; // 1 MHz off the 100 MHz clock
static uint32_t readCount = 1023;
static uint32_t delayCount = 1023;
static uint32_t triggerMask0 = 0;
static uint32_t triggerValue0 = 0;

static uint8_t *pattern = nullptr;
static uint32_t patternLen = 0;
static uint32_t patternRate = 0;

/**
 * Where the next capture starts in the pattern. Advanced by one capture length
 * after each upload, so consecutive captures tile the signal instead of being
 * byte-identical — which is what re-arming on a free-running bus really looks
 * like, and the only way the host's capture pager shows you anything. The first
 * capture after a reset is still at 0, so it matches the app's own demo capture
 * exactly and stays useful as a correctness check.
 */
static uint32_t phase = 0;

static inline uint32_t sampleRate() {
  return CLOCK_HZ / (divider + 1);
}
static inline uint32_t sampleCount() {
  uint32_t groups = readCount + 1;
  if (groups > 0x3fffffffUL) groups = 0x3fffffffUL; // keep the *4 in range
  return groups * 4;
}

// --- Pattern synthesis -------------------------------------------------------
// The demo signals come from tools/common/demo_pattern.h, shared with the FX2
// emulator; everything below is about *which slice* of them a capture returns.

/** (Re)build the pattern for the current rate. Cheap enough to redo per run. */
static bool preparePattern() {
  uint32_t rate = sampleRate();
  if (pattern && patternRate == rate) return true;

  free(pattern);
  // The pattern is one whole demo cycle, *not* clipped to what the host asked
  // for: a request shorter than the cycle is what makes successive captures tile
  // through it, and a longer one simply repeats it.
  pattern = demo::build(rate, PATTERN_CAP, &patternLen);
  if (!pattern) {
    patternLen = 0;
    return false;
  }
  patternRate = rate;
  phase %= patternLen; // a new rate resizes the cycle under us
  return true;
}

// --- Command handling --------------------------------------------------------

/** Read one byte, blocking up to `ms`. Returns -1 on timeout. */
static int readByte(uint32_t ms = 250) {
  uint32_t deadline = millis() + ms;
  while ((int32_t)(millis() - deadline) < 0) {
    int c = Serial.read();
    if (c >= 0) return c;
    delay(1);
  }
  return -1;
}

static uint32_t readLe32() {
  uint32_t v = 0;
  for (int i = 0; i < 4; i++) {
    int c = readByte();
    if (c < 0) return v;
    v |= (uint32_t)(c & 0xff) << (8 * i);
  }
  return v;
}

/** True if a reset arrived — the host pressing Stop, or starting over. */
static bool resetPending() {
  while (Serial.available()) {
    if (Serial.read() == CMD_RESET) {
      while (Serial.available()) Serial.read();
      return true;
    }
  }
  return false;
}

static void writeBe32(uint8_t key, uint32_t v) {
  uint8_t out[5] = {key, (uint8_t)(v >> 24), (uint8_t)(v >> 16),
                    (uint8_t)(v >> 8), (uint8_t)v};
  Serial.write(out, 5);
}

static void writeString(uint8_t key, const char *s) {
  Serial.write(key);
  Serial.write((const uint8_t *)s, strlen(s));
  Serial.write((uint8_t)0);
}

/** The 0x04 response: a TLV stream with BIG-endian integers, ended by 0x00. */
static void sendMetadata() {
#if DEV_SEND_METADATA
  writeString(0x01, DEV_NAME);
  writeString(0x02, DEV_FIRMWARE);
  writeBe32(0x20, 8);             // probes
  writeBe32(0x21, DEV_MEMORY);    // sample memory
  writeBe32(0x23, DEV_MAX_RATE);  // max sample rate
  writeBe32(0x24, 2);             // protocol version
  Serial.write((uint8_t)0);
  Serial.flush();
#endif
}

/** Where sample 0 of the capture sits in the pattern. Without a hardware
 *  trigger that is simply the start; with one, the first matching level. */
static bool findStart(uint32_t &startOut) {
#if DEV_HW_TRIGGER
  if (triggerMask0 != 0) {
    // Look forward from where the signal has got to, not from the top of the
    // pattern: the trigger fires on the *next* occurrence, as real hardware does.
    for (uint32_t k = 0; k < patternLen; k++) {
      uint32_t i = (phase + k) % patternLen;
      if ((pattern[i] & triggerMask0) == (triggerValue0 & triggerMask0)) {
        startOut = i;
        return true;
      }
    }
    return false; // armed, and the condition never occurs — stay silent
  }
#else
  (void)triggerValue0;
#endif
  startOut = phase;
  return true;
}

/** Upload the capture NEWEST SAMPLE FIRST, which is what SUMP hosts expect. */
static void uploadDump(uint32_t start, uint32_t total) {
  uint8_t block[512];
  size_t used = 0;
  for (uint32_t i = total; i-- > 0;) {
    block[used++] = pattern[(start + i) % patternLen];
    if (used == sizeof(block)) {
      Serial.write(block, used);
      used = 0;
      if (resetPending()) return; // Stop, mid-upload
    }
  }
  if (used) Serial.write(block, used);
  Serial.flush();
}

static void handleRun() {
  if (!preparePattern()) return;
  uint32_t total = sampleCount();
  if (total > DEV_MEMORY) total = DEV_MEMORY;

  uint32_t start = 0;
  if (!findStart(start)) {
    // Armed but never triggered. A real device sends nothing at all until the
    // condition fires, so neither do we — this is the case the host's Stop
    // button has to get you out of.
    while (!resetPending()) delay(10);
    return;
  }

  // Pretend to fill our own memory before uploading, as real hardware does.
  uint32_t captureMs = (uint32_t)((double)total * 1000.0 / (double)sampleRate());
  if (captureMs > MAX_FAKE_CAPTURE_MS) captureMs = MAX_FAKE_CAPTURE_MS;
  uint32_t until = millis() + captureMs;
  while ((int32_t)(millis() - until) < 0) {
    if (resetPending()) return;
    delay(1);
  }

  uploadDump(start, total);
  // Let the signal run on, so the next capture picks up where this one left off.
  phase = (start + total) % patternLen;
}

static void handleCommand(uint8_t cmd) {
  switch (cmd) {
    case CMD_RESET:
      while (Serial.available()) Serial.read();
      return;
    case CMD_RUN:
      handleRun();
      return;
    case CMD_ID:
      Serial.write((const uint8_t *)"1ALS", 4);
      Serial.flush();
      return;
    case CMD_METADATA:
      sendMetadata();
      return;
    case CMD_XON:
    case CMD_XOFF:
      return; // acknowledged and ignored; never act on these
    case CMD_SET_DIVIDER:
      divider = readLe32() & 0x00ffffff;
      return;
    case CMD_CAPTURE_SIZE: {
      uint32_t v = readLe32();
      readCount = v & 0xffff;
      delayCount = (v >> 16) & 0xffff;
      return;
    }
#if DEV_WIDE_COUNTS
    case CMD_CAPTURE_READCOUNT:
      readCount = readLe32();
      return;
    case CMD_CAPTURE_DELAYCOUNT:
      delayCount = readLe32();
      return;
#endif
    case CMD_SET_FLAGS:
      // Only channel group 0 is ever populated here, so the flags word is read
      // and dropped — but its 4 payload bytes must still be consumed.
      readLe32();
      return;
    default:
      break;
  }

  if (cmd >= CMD_TRIGGER_FIRST && cmd <= CMD_TRIGGER_LAST) {
    uint32_t arg = readLe32();
    if (cmd == 0xc0) triggerMask0 = arg;
    if (cmd == 0xc1) triggerValue0 = arg;
    // Stage config (0xc2) and stages 1-3 are accepted and dropped.
    return;
  }

#if DEV_BUGGY_LONG_CMDS
  // Deliberately wrong, matching ESP32-Bit-Pirate: an unknown opcode >= 0x80 is
  // dropped without consuming its payload, so those 4 bytes get read as
  // commands and the rest of the arm sequence is misparsed. A host that never
  // sends an unknown long command never notices.
  (void)0;
#else
  if (cmd >= 0x80) readLe32();
#endif
}

// --- Arduino entry points ----------------------------------------------------

void setup() {
  Serial.begin(115200); // ignored on USB CDC, which runs at full USB speed
  delay(200);
}

void loop() {
  int c = Serial.read();
  if (c >= 0) handleCommand((uint8_t)c);
  else delay(1);
}
