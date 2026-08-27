// FX2 / fx2lafw device emulator for ESP32-S3 / ESP32-S2.
//
// A bench target for the app's FX2 backend when you have no real hardware. It
// enumerates as a vendor-class USB device with a bulk IN endpoint, answers the
// fx2lafw vendor commands and — instead of sampling pins — *streams* the same
// signals as the app's built-in demo capture (src/demo/capture.ts): UART on D0,
// SPI on D1-D3, I2C on D4/D5, 1-Wire on D6, CAN on D7.
//
// Synthesizing is the point (see tools/common/demo_pattern.h). The pattern is
// laid out at whatever rate the host's clock/divider bytes resolve to, so the
// whole path is self-checking:
//
//   * if the host mislabels the rate it asked for, the UART decodes at the wrong
//     baud and the CAN frames come out at the wrong bit rate;
//   * if the host reads the wrong endpoint, no samples arrive at all;
//   * if the host lets the queue drain (one transfer in flight, a blocked main
//     thread), the throughput report on the debug UART shows the gaps.
//
// It also emulates the Cypress bootloader — see PERSONA below — so the firmware
// upload / re-enumerate path can be exercised too.
//
// Only the S2/S3 can do this: the C3's USB peripheral is a fixed-function
// serial/JTAG bridge with no custom descriptors, which is why the SUMP emulator
// runs on more boards than this one does.
//
// Build: pio run -e s3 -t upload   (see platformio.ini for the other personas)

#include <Arduino.h>
#include <USB.h>
#include <USBVendor.h>
#include <esp32-hal-tinyusb.h>
#include <esp_system.h>

#include "../../common/demo_pattern.h"

// --- Persona -----------------------------------------------------------------
// Which device this pretends to be. Set from platformio.ini build_flags; the
// identities are rows of the app's own table (src/usb/constants.ts).

/** Identity of a device already running fx2lafw. The app keys off the string
 *  descriptors first (needsFirmware()), so these two strings are what make it
 *  skip the upload — not the VID:PID. */
#ifndef DEV_VID
#define DEV_VID 0x1d50 // sigrok FX2 LA (8ch)
#endif
#ifndef DEV_PID
#define DEV_PID 0x608c
#endif
#ifndef DEV_MANUFACTURER
#define DEV_MANUFACTURER "sigrok"
#endif
#ifndef DEV_PRODUCT
#define DEV_PRODUCT "fx2lafw"
#endif

// 1 = boot on a stock Cypress identity with no firmware, so the app uploads
// fx2lafw and waits for the re-enumeration. We "boot the firmware" by rebooting
// into the identity above — and, like the real thing, we forget it again on a
// power cycle or a RESET, because the FX2 holds its firmware in RAM.
#ifndef DEV_STOCK
#define DEV_STOCK 0
#endif
#ifndef DEV_STOCK_VID
#define DEV_STOCK_VID 0x04b4 // Cypress FX2, the app's fx2lafw-cypress-fx2.fw row
#endif
#ifndef DEV_STOCK_PID
#define DEV_STOCK_PID 0x8613
#endif
#ifndef DEV_STOCK_MANUFACTURER
#define DEV_STOCK_MANUFACTURER "Cypress"
#endif
#ifndef DEV_STOCK_PRODUCT
#define DEV_STOCK_PRODUCT "FX2"
#endif

// Endpoint number the samples arrive on. Real fx2lafw uses 2 (0x82); the host
// is supposed to read the address out of the descriptor rather than assume it,
// which is what the ep1 persona checks. The S2/S3 have IN endpoints 1-4 only,
// so old firmware's 0x86 is out of reach here.
#ifndef DEV_BULK_EP
#define DEV_BULK_EP 2
#endif

// Answered to CMD_GET_FW_VERSION. The app requires major 1 and refuses anything
// else, which the oldfw persona is for.
#ifndef DEV_FW_MAJOR
#define DEV_FW_MAJOR 1
#endif
#ifndef DEV_FW_MINOR
#define DEV_FW_MINOR 3
#endif
/** FX2 silicon revision, answered to CMD_GET_REVID_VERSION (informational). */
#ifndef DEV_REVID
#define DEV_REVID 2
#endif

// KiB to stream before going silent for good, imitating the FX2 FIFO overflowing
// when the host falls behind: the stream never comes back, and the host's stall
// watchdog is the only thing that ends the capture. 0 = stream forever.
#ifndef DEV_STALL_AFTER_KB
#define DEV_STALL_AFTER_KB 0
#endif

// Milliseconds between UART lines in the "tick" persona. Set, it replaces the
// demo cycle with a far quieter signal: D0 carries one line a second — "tick 1",
// "tick 2", … — and every channel idles in between. The demo cycle is 6.5 ms of
// wall clock, which tells you nothing about a live view; a capture of this one
// spans real time, so the follow view scrolls, the Serial Monitor fills a line
// at a time, and a live decode has long stretches of nothing to survive.
// 0 = stream the demo cycle.
#ifndef DEV_TICK_MS
#define DEV_TICK_MS 0
#endif
#ifndef DEV_TICK_TEXT
#define DEV_TICK_TEXT "tick"
#endif
#ifndef DEV_TICK_BAUD
#define DEV_TICK_BAUD 115200
#endif

// --- Protocol ----------------------------------------------------------------
// fx2lafw's vendor commands, from libsigrok's fx2lafw protocol.h.

static const uint8_t REQ_FIRMWARE_LOAD = 0xa0; // Cypress bootloader RAM write
static const uint16_t CPUCS_ADDR = 0xe600;     // bit 0 holds the 8051 in reset
static const uint8_t CMD_GET_FW_VERSION = 0xb0;
static const uint8_t CMD_START = 0xb1;
static const uint8_t CMD_GET_REVID_VERSION = 0xb2;

/** cmd_start_acquisition.flags: bit 5 = 16-bit samples, bit 6 = 48 MHz clock. */
static const uint8_t FLAG_SAMPLE_16BIT = 0x20;
static const uint8_t FLAG_CLK_48MHZ = 0x40;
static const uint32_t CLK_48MHZ = 48000000UL;
static const uint32_t CLK_30MHZ = 30000000UL;

/** Ceiling on the synthesized pattern, so a high rate can't exhaust the heap.
 *  Beyond this the demo cycle is truncated, not refused. */
static const uint32_t PATTERN_CAP = 96 * 1024;

/** Samples we are willing to owe the host when the link can't keep up. Without
 *  a cap the debt from a slow link would grow forever and a later rate change
 *  would dump it all at once. */
static const uint32_t MAX_BACKLOG = 64 * 1024;

/** Full-speed bulk max packet size, and the batch the pacing works in. */
static const uint32_t PACKET = 64;

/** Bytes handed to the endpoint per pump(), so loop() stays responsive. */
static const uint32_t PUMP_BUDGET = 4 * 1024;

// --- State -------------------------------------------------------------------

USBVendor Vendor;

/** Set once we are pretending to run fx2lafw. Survives the reboot that stands in
 *  for the FX2's re-enumeration, but not a power cycle or a RESET — the real
 *  chip loses its RAM firmware just as easily.
 *
 *  RTC_NOINIT_ATTR, not RTC_DATA_ATTR: .rtc.data is a loaded section, so
 *  esp_restart() re-initializes it and the flag would never survive the one
 *  reboot it exists for — the board would come back on the stock identity and be
 *  handed the firmware again, forever. .rtc_noinit is not initialized at all,
 *  which is what FIRMWARE_MAGIC is for: on a cold boot it holds garbage, and the
 *  reset-reason check below is what turns that into "needs firmware". */
static RTC_NOINIT_ATTR uint32_t rtcFirmwareLoaded;
static const uint32_t FIRMWARE_MAGIC = 0x66783266; // "fx2f"

static bool running = false; // false = still the stock, un-firmwared identity

static uint32_t sourceRate = 0; // rate the signal source is laid out for

static bool streaming = false;
static uint32_t sampleRateHz = 0;
static bool wideMode = false;
static uint64_t sent = 0;
static uint32_t lastPumpUs = 0;
static uint64_t credit = 0;  // sample-microseconds owed, below one whole sample
static uint32_t pending = 0; // whole samples owed
static uint32_t reportedAtMs = 0;
static uint64_t reportedAtSent = 0;
static bool stallAnnounced = false;

// Control-transfer payloads. TinyUSB keeps the pointer we hand it until the data
// stage has run, so none of these may live on the stack.
static uint8_t startCmd[3];
static uint8_t fwChunk[4096]; // the app's FW_CHUNK_SIZE
static uint8_t fwVersion[2] = {DEV_FW_MAJOR, DEV_FW_MINOR};
static uint8_t revId[1] = {DEV_REVID};

/** Set from the USB task, acted on in loop(). */
static volatile bool startPending = false;
static volatile bool bootPending = false;

// --- Firmware upload ---------------------------------------------------------
// We keep none of the image — there is no 8051 here. What the bytes are good for
// is checking that the host drives the bootloader the way an FX2 needs: CPU held
// in reset, the image written to ascending addresses, then reset released.

static bool cpuHeld = false;
static uint32_t fwBytes = 0;
static uint32_t fwNextAddr = 0;

static void noteFirmwareWrite(uint16_t addr, uint16_t len) {
  if (addr == CPUCS_ADDR) {
    bool held = (fwChunk[0] & 1) != 0;
    if (held) {
      cpuHeld = true;
      fwBytes = 0;
      fwNextAddr = 0;
      Serial.println("[fw] CPU held in reset");
    } else {
      Serial.printf("[fw] CPU released after %u bytes\n", fwBytes);
      if (fwBytes == 0) {
        Serial.println("[fw] !! reset released with no image written");
      } else {
        bootPending = true;
      }
      cpuHeld = false;
    }
    return;
  }

  if (!cpuHeld) Serial.println("[fw] !! image written while the 8051 is running");
  if (addr != fwNextAddr) {
    Serial.printf("[fw] !! chunk at 0x%04x, expected 0x%04x\n", addr, fwNextAddr);
  }
  fwBytes += len;
  fwNextAddr = addr + len;
}

// --- Capture -----------------------------------------------------------------

// Where the samples come from. Both sources answer the same three calls, so
// beginStream() and pump() never learn which persona they are running:
//
//   prepareSource(rate)  lay the signal out for a rate; false = give up
//   resetSource()        a run is starting
//   writeSamples(budget) hand the endpoint up to `budget` samples, return how
//                        many it took (0 = full, the host is not draining)

#if DEV_TICK_MS

// --- Source: one UART line every DEV_TICK_MS ---------------------------------
// Only the line is buffered. A period of idle is counted, not stored: a second
// at 4 MHz would be 4 MB, and it is the same byte throughout anyway. The line
// leads its period, so a capture carries one from its very first samples rather
// than opening with a second of nothing.

static const uint32_t TICK_TEXT_MAX = 48;
/** Ceiling on one line's samples, so a high rate can't exhaust the heap. */
static const uint32_t TICK_LINE_CAP = 32 * 1024;

static uint8_t *tickLine = nullptr; // the line, as packed samples
static uint32_t tickLineLen = 0;
static uint32_t tickLinePos = 0;
static uint32_t tickPeriod = 0;   // samples between one line and the next
static uint32_t tickIdleLeft = 0; // idle samples still owed this period
static uint32_t tickCounter = 0;
static uint8_t tickIdle[512];

static const uint8_t LINE_LOW = (uint8_t)(demo::IDLE_BYTE & ~1u);

/** Sample index of bit `k`'s leading edge. Every edge is placed from its own
 *  absolute time, as demo_pattern.h does, so the error cannot accumulate: a
 *  115200 bit is 8.68 samples at 1 MHz, and rounding each to 9 would walk a
 *  third of a bit per byte and lose the stop bit by the end of a line. */
static inline uint32_t tickBitEdge(uint32_t k, uint32_t rate) {
  return (uint32_t)(((uint64_t)k * rate + DEV_TICK_BAUD / 2) / DEV_TICK_BAUD);
}

/** Render the next line into tickLine: 8-N-1, LSB-first, idle high on D0, the
 *  other channels held at their protocol idle. Same framing as the demo, so the
 *  app's UART decoder needs nothing changed off its defaults. */
static void buildTickLine(uint32_t rate) {
  char text[TICK_TEXT_MAX];
  int len = snprintf(text, sizeof(text), DEV_TICK_TEXT " %u\n",
                     (unsigned)++tickCounter);
  if (len < 0) len = 0;
  if ((uint32_t)len >= sizeof(text)) len = sizeof(text) - 1;

  // Levels, one per bit: two bit times of idle, then start / 8 data / stop per
  // character, then idle again to separate this line from the next.
  static uint8_t bits[2 + 10 * TICK_TEXT_MAX + 2];
  uint32_t n = 0;
  bits[n++] = 1;
  bits[n++] = 1;
  for (int i = 0; i < len; i++) {
    bits[n++] = 0;
    for (int b = 0; b < 8; b++) bits[n++] = (text[i] >> b) & 1;
    bits[n++] = 1;
  }
  bits[n++] = 1;
  bits[n++] = 1;

  uint32_t total = tickBitEdge(n, rate);
  if (total > TICK_LINE_CAP) {
    total = TICK_LINE_CAP;
    // Only reachable with a long DEV_TICK_TEXT at a high rate. The line loses
    // its tail mid-character, so say so once rather than let it look like a
    // decoder problem.
    static bool warned = false;
    if (!warned) {
      warned = true;
      Serial.printf("[cap] !! the line needs more than %u samples — truncated; "
                    "shorter text or a lower rate\n",
                    TICK_LINE_CAP);
    }
  }
  for (uint32_t k = 0; k < n; k++) {
    uint32_t from = tickBitEdge(k, rate);
    if (from >= total) break;
    uint32_t to = tickBitEdge(k + 1, rate);
    if (to > total) to = total;
    memset(tickLine + from, bits[k] ? demo::IDLE_BYTE : LINE_LOW, to - from);
  }

  tickLineLen = total;
  tickLinePos = 0;
  tickIdleLeft = tickPeriod > total ? tickPeriod - total : 0;
}

static bool prepareSource(uint32_t rate) {
  if (tickLine && sourceRate == rate) return true;

  if (!tickLine) tickLine = (uint8_t *)malloc(TICK_LINE_CAP);
  if (!tickLine) {
    Serial.println("[cap] !! out of memory building the tick line");
    return false;
  }
  memset(tickIdle, demo::IDLE_BYTE, sizeof(tickIdle));
  sourceRate = rate;
  tickPeriod = (uint32_t)((uint64_t)rate * DEV_TICK_MS / 1000);

  uint32_t spb10 = (uint32_t)(((uint64_t)rate * 10 + DEV_TICK_BAUD / 2) / DEV_TICK_BAUD);
  Serial.printf("[cap] tick: one \"" DEV_TICK_TEXT " n\" line every %u ms, "
                "%u.%u samples/bit at %u baud\n",
                (unsigned)DEV_TICK_MS, spb10 / 10, spb10 % 10,
                (unsigned)DEV_TICK_BAUD);
  // Two samples a bit is where a receiver stops being able to find mid-bit; a
  // sweep of the generator decodes cleanly from 250 kHz up and garbles at 200.
  // The line is in the samples either way — there are just too few of them.
  if (rate < 2 * (uint32_t)DEV_TICK_BAUD) {
    Serial.printf("[cap] !! %u Hz is under two samples per bit at %u baud — the "
                  "line will not decode; try 1 MHz\n",
                  rate, (unsigned)DEV_TICK_BAUD);
  }
  return true;
}

/** Restart the sequence, so every run opens with "tick 1". */
static void resetSource() {
  tickCounter = 0;
  tickLineLen = 0;
  tickLinePos = 0;
  tickIdleLeft = 0;
}

static uint32_t writeSamples(uint32_t budget) {
  if (tickLinePos >= tickLineLen && tickIdleLeft == 0) buildTickLine(sourceRate);

  if (tickLinePos < tickLineLen) {
    uint32_t run = tickLineLen - tickLinePos;
    if (run > budget) run = budget;
    size_t n = Vendor.write(tickLine + tickLinePos, run);
    tickLinePos += n;
    return n;
  }

  uint32_t run = tickIdleLeft;
  if (run > budget) run = budget;
  if (run > sizeof(tickIdle)) run = sizeof(tickIdle);
  size_t n = Vendor.write(tickIdle, run);
  tickIdleLeft -= n;
  return n;
}

#else

// --- Source: the app's demo capture, streamed in a loop ----------------------

static uint8_t *pattern = nullptr;
static uint32_t patternLen = 0;
static uint32_t pos = 0;

/** Lay the demo signals out at `rate`. Cheap enough to redo whenever it moves. */
static bool prepareSource(uint32_t rate) {
  if (pattern && sourceRate == rate) return true;

  free(pattern);
  pattern = demo::build(rate, PATTERN_CAP, &patternLen);
  if (!pattern) {
    patternLen = 0;
    Serial.println("[cap] !! out of memory building the pattern");
    return false;
  }
  sourceRate = rate;
  Serial.printf("[cap] pattern: %u samples (%u.%03u ms of signal)\n", patternLen,
                (unsigned)((uint64_t)patternLen * 1000 / rate),
                (unsigned)((uint64_t)patternLen * 1000000 / rate % 1000));
  return true;
}

/** Start each run at the top of the cycle: the first samples of a capture then
 *  match the app's own demo capture, which is what makes it a reference. */
static void resetSource() {
  pos = 0;
}

static uint32_t writeSamples(uint32_t budget) {
  uint32_t run = patternLen - pos;
  if (run > budget) run = budget;
  size_t n = Vendor.write(pattern + pos, run);
  pos += n;
  if (pos >= patternLen) pos = 0;
  return n;
}

#endif

/**
 * CMD_START: decode the clock/divider the host chose and start streaming.
 *
 * The FX2 divides 48 or 30 MHz by (delay + 1); the app's encodeSampleRate() is
 * what we are checking here, so we lay the signals out at whatever those three
 * bytes actually mean rather than at whatever was picked in the UI.
 */
static void beginStream() {
  uint16_t delay = ((uint16_t)startCmd[1] << 8) | startCmd[2];
  uint32_t base = (startCmd[0] & FLAG_CLK_48MHZ) ? CLK_48MHZ : CLK_30MHZ;
  sampleRateHz = base / (delay + 1u);
  wideMode = (startCmd[0] & FLAG_SAMPLE_16BIT) != 0;

  Serial.printf("[cap] START flags=0x%02x delay=%u -> %u Hz off %u MHz, %s\n",
                startCmd[0], delay, sampleRateHz, base / 1000000,
                wideMode ? "16-bit" : "8-bit");
  if (wideMode) {
    // The app captures in 8-bit mode only; a 16-bit request would mean two bytes
    // per sample, which we do not synthesize.
    Serial.println("[cap] !! 16-bit mode requested; streaming 8-bit anyway");
  }
  if (!prepareSource(sampleRateHz)) return;
  resetSource();

  sent = 0;
  pending = 0;
  credit = 0;
  lastPumpUs = micros();
  reportedAtMs = millis();
  reportedAtSent = 0;
  stallAnnounced = false;
  streaming = true;
}

/** Report achieved throughput once a second — the only way to see whether the
 *  link is keeping up with the rate the host asked for. */
static void reportThroughput() {
  uint32_t now = millis();
  uint32_t ms = now - reportedAtMs;
  if (ms < 1000) return;
  uint32_t bytes = (uint32_t)(sent - reportedAtSent);
  // 8-bit samples, so the rate the host asked for is a kB/s figure too.
  Serial.printf("[cap] %u kB/s of the %u asked, %llu kB total, %u behind\n",
                bytes / ms, sampleRateHz / 1000,
                (unsigned long long)(sent / 1000), pending);
  reportedAtMs = now;
  reportedAtSent = sent;
}

/**
 * Hand the endpoint as much of the pattern as the host is owed and the link will
 * take. Pacing to the requested rate is what makes the follow view and the
 * serial monitor behave like real hardware at the rates the link can sustain;
 * above those the debt is capped and the capture simply takes longer than it
 * would on a real FX2 (the samples themselves are unaffected).
 */
static void pump() {
  if (!Vendor.mounted()) {
    streaming = false;
    return;
  }

  uint32_t now = micros();
  credit += (uint64_t)(uint32_t)(now - lastPumpUs) * sampleRateHz;
  lastPumpUs = now;
  uint64_t owed = pending + credit / 1000000ULL;
  credit %= 1000000ULL;
  pending = owed > MAX_BACKLOG ? MAX_BACKLOG : (uint32_t)owed;

#if DEV_STALL_AFTER_KB
  if (sent >= (uint64_t)DEV_STALL_AFTER_KB * 1024) {
    if (!stallAnnounced) {
      stallAnnounced = true;
      Serial.printf("[cap] FIFO \"overflow\" after %u KB — going silent\n",
                    (unsigned)DEV_STALL_AFTER_KB);
    }
    return;
  }
#endif

  // Hand over whole packets only. Full-speed USB moves at most ~19 bulk packets
  // per 1 ms frame whatever their size, so a byte at a time would run out of
  // packets long before it ran out of bandwidth — at 20 kHz that alone would cap
  // us below the requested rate. A packet of latency there is 3 ms.
  if (pending < PACKET) return;
  uint32_t budget = pending & ~(PACKET - 1);
  if (budget > PUMP_BUDGET) budget = PUMP_BUDGET;

  while (budget) {
    uint32_t n = writeSamples(budget);
    if (!n) break; // endpoint full: the host is not draining it
    sent += n;
    pending -= n;
    budget -= n;
  }
  // Flushed once, not per write: a source that hands over short runs — the tick
  // line, or the pattern at its wrap — would otherwise put a short packet on the
  // wire for each, and full-speed USB runs out of packets long before bandwidth.
  Vendor.flush();
}

// --- USB ---------------------------------------------------------------------

static bool onVendorRequest(uint8_t rhport, uint8_t stage,
                            arduino_usb_control_request_t const *request) {
  if (request->bmRequestType != REQUEST_TYPE_VENDOR) return false;

  switch (request->bRequest) {
    case REQ_FIRMWARE_LOAD:
      // Only the bootloader answers this. Once fx2lafw is running the 8051 has
      // taken over the endpoint and an 0xa0 stalls, as it does on real hardware.
      if (running || request->bmRequestDirection != REQUEST_DIRECTION_OUT) {
        return false;
      }
      if (stage == REQUEST_STAGE_SETUP) {
        uint16_t len = request->wLength;
        if (len > sizeof(fwChunk)) {
          Serial.printf("[fw] !! %u-byte chunk, over the 4096 the FX2 takes\n", len);
          return false;
        }
        return Vendor.sendResponse(rhport, request, fwChunk, len);
      }
      if (stage == REQUEST_STAGE_ACK) {
        noteFirmwareWrite(request->wValue, request->wLength);
      }
      return true;

    case CMD_GET_FW_VERSION:
      if (!running) return false;
      if (stage == REQUEST_STAGE_SETUP) {
        return Vendor.sendResponse(rhport, request, fwVersion, sizeof(fwVersion));
      }
      return true;

    case CMD_GET_REVID_VERSION:
      if (!running) return false;
      if (stage == REQUEST_STAGE_SETUP) {
        return Vendor.sendResponse(rhport, request, revId, sizeof(revId));
      }
      return true;

    case CMD_START:
      if (!running) return false;
      if (stage == REQUEST_STAGE_SETUP) {
        if (request->wLength != sizeof(startCmd)) return false;
        return Vendor.sendResponse(rhport, request, startCmd, sizeof(startCmd));
      }
      if (stage == REQUEST_STAGE_ACK) startPending = true;
      return true;

    default:
      return false; // anything else stalls, as an FX2 would
  }
}

static void onUsbEvent(void *, esp_event_base_t base, int32_t id, void *) {
  if (base != ARDUINO_USB_EVENTS) return;
  // A bus reset arrives as unmount/mount, and a bus reset is exactly how the app
  // stops a capture (fx2lafw has no stop command). Dropping the stream here is
  // what makes the next Run start from the top of the cycle again.
  if (id == ARDUINO_USB_STOPPED_EVENT || id == ARDUINO_USB_SUSPEND_EVENT) {
    if (streaming) Serial.println("[cap] host reset the device — stream dropped");
    streaming = false;
  }
}

// --- Arduino entry points ----------------------------------------------------

void setup() {
  Serial.begin(115200); // UART0: the debug log, separate from the emulated USB
  delay(200);

  // The FX2 keeps its firmware in RAM, so only a *software* restart — ours,
  // standing in for the re-enumeration — carries the loaded state over.
  if (esp_reset_reason() != ESP_RST_SW) rtcFirmwareLoaded = 0;
  running = !DEV_STOCK || rtcFirmwareLoaded == FIRMWARE_MAGIC;

  Serial.printf("\nFX2 emulator — %s\n",
                running ? DEV_MANUFACTURER " " DEV_PRODUCT " (running fx2lafw)"
                        : DEV_STOCK_MANUFACTURER " " DEV_STOCK_PRODUCT
                                                 " (needs firmware)");

  // USBVendor takes the first free duplex endpoint, so burn the ones below the
  // address we want the samples to arrive on. Wasting an endpoint number costs
  // nothing here (nothing else claims one) and it buys a bulk IN address that
  // matches the real hardware.
  for (uint8_t ep = 1; ep < DEV_BULK_EP; ep++) tinyusb_get_free_duplex_endpoint();
  Vendor.onRequest(onVendorRequest);
  Vendor.begin();

  USB.VID(running ? DEV_VID : DEV_STOCK_VID);
  USB.PID(running ? DEV_PID : DEV_STOCK_PID);
  USB.manufacturerName(running ? DEV_MANUFACTURER : DEV_STOCK_MANUFACTURER);
  USB.productName(running ? DEV_PRODUCT : DEV_STOCK_PRODUCT);
  // Vendor-specific at the device level too, like an FX2: one vendor interface,
  // no IAD, nothing for the OS to bind a class driver to.
  USB.usbClass(TUSB_CLASS_VENDOR_SPECIFIC);
  USB.usbSubClass(0xff);
  USB.usbProtocol(0xff);
  // No USB.webUSB(): its landing-page descriptor carries a URL, and Chrome
  // offers to open that page on every plug-in. A real FX2 advertises neither
  // that nor the MS-OS descriptors that ride along with it in this core, so on
  // Windows this wants the same manual WinUSB binding real hardware does.
  USB.onEvent(onUsbEvent);
  USB.begin();

  Serial.printf("USB %04x:%04x, samples on EP 0x%02x\n", USB.VID(), USB.PID(),
                0x80 | DEV_BULK_EP);
}

void loop() {
  if (bootPending) {
    // The 8051 would boot the image we were just sent and re-enumerate. We
    // reboot into the other identity instead — after the control transfer's
    // status stage, or the app would see the CPUCS write itself fail.
    bootPending = false;
    rtcFirmwareLoaded = FIRMWARE_MAGIC;
    Serial.println("[fw] booting fx2lafw — re-enumerating");
    Serial.flush();
    delay(20);
    esp_restart();
  }

  if (startPending) {
    startPending = false;
    beginStream();
  }

  if (streaming) {
    pump();
    reportThroughput();
  } else {
    delay(1);
  }
}
