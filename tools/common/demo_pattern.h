#pragma once
// The app's built-in demo capture (src/demo/capture.ts), synthesized as packed
// 8-channel samples: UART on D0, SPI on D1-D3, I2C on D4/D5, 1-Wire on D6, CAN
// on D7. Shared by tools/sump-emulator and tools/fx2-emulator so the two cannot
// drift from each other or from the app's reference picture.
//
// Synthesizing is the point. Every duration is expressed in microseconds (the
// demo is built at 1 sample/us, so its numbers carry over unchanged) and
// converted with whatever sample rate the host asked for, so each protocol keeps
// its real-world bit rate at any rate. That is what makes an emulator built on
// this self-checking: a host that mislabels the rate it resolved decodes the
// UART at the wrong baud and the CAN frames at the wrong bit rate. At 1 MHz the
// output is byte-identical to the app's own demo capture.
//
// "At any rate" is load-bearing and was once false: rounding each run on its own
// made the UART's real baud rate / round(rate / baud), so at 500 kHz it emitted
// 125000 baud and the app decoded "Hello\n" as A0 B5 B4 B4 B7 82. Edges are now
// placed from absolute time (see Pen::exact), and the app reads the line back
// cleanly at 400 kHz, 500 kHz, 750 kHz, 1/2/24 MHz — the awkward ratios being
// exactly the ones that used to fail.
//
// Header-only, and included by exactly one translation unit per firmware.

#include <stdint.h>
#include <stdlib.h>
#include <string.h>

namespace demo {

/** Per-channel idle levels, D0..D7 — 0xF1. */
static const uint8_t IDLE_BYTE = 0b11110001;

namespace detail {

/** Idle microseconds framing each protocol's window. */
static const double GAP_US = 200;

static uint8_t *buffer = nullptr;
static uint32_t bufferLen = 0;
static uint32_t rate = 1000000;

static inline uint32_t usToSamples(double us) {
  double n = us * (double)rate / 1000000.0;
  return n < 1 ? 1 : (uint32_t)(n + 0.5);
}

/**
 * A write head on one channel: which bit it owns, how far it has written, and
 * where its next edge exactly belongs.
 *
 * `exact` is the reason this is not just a cursor. Rounding each run on its own
 * makes the error accumulate: a 115200 bit is 4.34 samples at 500 kHz, and nine
 * runs of 4 put the stop bit almost a whole bit early, so the line decodes as
 * garbage. Carrying the fractional position and rounding the *absolute* edge
 * keeps every edge within half a sample of its true time however awkward the
 * ratio, which is what lets one pattern be laid out at any rate.
 */
struct Pen {
  uint8_t ch;
  uint32_t pos;  // samples written
  double exact;  // where the next edge belongs, in exact samples

  Pen(uint8_t channel, uint32_t at)
      : ch(channel), pos(at), exact((double)at) {}
};

/** Append `n` samples of `level` on this pen's channel. With a null buffer this
 *  only advances the cursor, which is how the first pass measures the cycle. */
static void put(Pen &p, uint8_t level, uint32_t n) {
  if (buffer) {
    uint32_t end = p.pos + n;
    if (end > bufferLen) end = bufferLen; // truncated cycle, not an error
    for (uint32_t i = p.pos; i < end; i++) {
      if (level)
        buffer[i] |= (1u << p.ch);
      else
        buffer[i] &= ~(1u << p.ch);
    }
  }
  p.pos += n;
}

/** Hold `level` for `us` microseconds, ending at the rounded absolute time. */
static void putUs(Pen &p, uint8_t level, double us) {
  p.exact += us * (double)rate / 1000000.0;
  uint32_t target = (uint32_t)(p.exact + 0.5);
  // Never fewer than one sample: below ~2 samples/bit the rate cannot represent
  // the signal at all, and dropping the run would delete the edge rather than
  // just blur it. The app warns about rates that low.
  put(p, level, target > p.pos ? target - p.pos : 1);
}

/** 8-N-1, LSB-first, idle high. */
static void uartByte(Pen &p, uint8_t b, double bitUs) {
  putUs(p, 1, bitUs * 2);
  putUs(p, 0, bitUs);
  for (int i = 0; i < 8; i++) putUs(p, (b >> i) & 1, bitUs);
  putUs(p, 1, bitUs * 2);
}

/** 3-wire SPI, CPOL0/CPHA0, MSB-first, sampled on the rising edge. */
static void spiStep(Pen &clk, Pen &mosi, Pen &miso, uint8_t c, uint8_t m,
                    uint8_t s, double us) {
  putUs(clk, c, us);
  putUs(mosi, m, us);
  putUs(miso, s, us);
}

/** One I2C phase: hold SCL and SDA for one half-bit. */
static void i2cPhase(Pen &scl, Pen &sda, uint8_t c, uint8_t d, double us) {
  putUs(scl, c, us);
  putUs(sda, d, us);
}

static void i2cBit(Pen &scl, Pen &sda, uint8_t bit, double us) {
  i2cPhase(scl, sda, 0, bit, us); // SCL low, set up SDA
  i2cPhase(scl, sda, 1, bit, us); // SCL high -> bit sampled
}

static void i2cTransaction(Pen &scl, Pen &sda, const uint8_t *bytes, int count,
                           double n) {
  i2cPhase(scl, sda, 1, 1, n * 2); // idle: both high
  i2cPhase(scl, sda, 1, 0, n);     // START: SDA falls while SCL high
  for (int b = 0; b < count; b++) {
    for (int i = 7; i >= 0; i--) i2cBit(scl, sda, (bytes[b] >> i) & 1, n);
    i2cBit(scl, sda, 0, n); // ACK
  }
  i2cPhase(scl, sda, 0, 0, n); // STOP setup
  i2cPhase(scl, sda, 1, 0, n);
  i2cPhase(scl, sda, 1, 1, n); // SDA rises while SCL high
  i2cPhase(scl, sda, 1, 1, n * 2);
}

/** Reset, presence, then bytes LSB-first: short low = 1, long low = 0. */
static void oneWireBytes(Pen &p, const uint8_t *bytes, int count) {
  putUs(p, 1, 100);
  putUs(p, 0, 500); // reset (>= 300us)
  putUs(p, 1, 50);  // recovery
  putUs(p, 0, 120); // presence pulse
  putUs(p, 1, 50);
  for (int b = 0; b < count; b++) {
    for (int i = 0; i < 8; i++) {
      double low = ((bytes[b] >> i) & 1) ? 5 : 60;
      putUs(p, 0, low);
      putUs(p, 1, 70 - low);
    }
    putUs(p, 1, 40); // inter-byte recovery
  }
  putUs(p, 1, 100);
}

/** Classical CAN standard data frame, dominant = 0, with 5-bit stuffing. */
static void canFrame(Pen &p, uint16_t id, const uint8_t *data, int dlc,
                     double bitUs) {
  uint8_t logical[160];
  int n = 0;
  logical[n++] = 0;                                        // SOF
  for (int i = 10; i >= 0; i--) logical[n++] = (id >> i) & 1;
  logical[n++] = 0;                                        // RTR
  logical[n++] = 0;                                        // IDE
  logical[n++] = 0;                                        // r0
  for (int i = 3; i >= 0; i--) logical[n++] = (dlc >> i) & 1;
  for (int b = 0; b < dlc; b++)
    for (int i = 7; i >= 0; i--) logical[n++] = (data[b] >> i) & 1;
  for (int i = 14; i >= 0; i--) logical[n++] = (0x2aaa >> i) & 1; // CRC

  putUs(p, 1, 40); // idle recessive
  int prev = -1, run = 0;
  for (int i = 0; i < n; i++) {
    uint8_t b = logical[i];
    putUs(p, b, bitUs);
    if (b == prev) {
      run++;
    } else {
      prev = b;
      run = 1;
    }
    if (run == 5) { // stuff the opposite bit
      prev ^= 1;
      run = 1;
      putUs(p, prev, bitUs);
    }
  }
  const uint8_t tail[] = {1, 0, 1, 1, 1, 1, 1, 1, 1, 1}; // CRC delim, ACK, EOF
  for (uint8_t b : tail) putUs(p, b, bitUs);
  putUs(p, 1, 40);
}

/** Lay down one full demo cycle. Returns its length in samples. With no buffer
 *  nothing is written and this just measures — the sizing pass. */
static uint32_t buildCycle() {
  uint32_t origin = usToSamples(GAP_US);

  // D0: UART "Hello\n". 9us per bit, which is what the app's own demo capture
  // realizes at its 1 MHz (src/demo/capture.ts rounds 8.68us up to 9 samples),
  // so this stays byte-identical to it there — the invariant both emulators are
  // checked against. It is nominally 111111 baud rather than 115200, and the
  // app's UART decoder reads it at 115200 cleanly at every rate from 230 kHz to
  // 24 MHz (measured), the 3.5% offset being well inside UART tolerance.
  const double uartBitUs = 9;
  Pen d0(0, origin);
  for (const char *s = "Hello\n"; *s; s++) uartByte(d0, (uint8_t)*s, uartBitUs);
  origin = d0.pos + usToSamples(GAP_US);

  // D1-D3: SPI, 8us per half-bit (~62.5 kHz).
  const double half = 8;
  Pen clk(1, origin), mosi(2, origin), miso(3, origin);
  const uint8_t tx[] = {0x9f, 0xa5, 0x3c}, rx[] = {0xef, 0x5a, 0xc3};
  spiStep(clk, mosi, miso, 0, 0, 0, half * 2);
  for (int w = 0; w < 3; w++) {
    for (int i = 7; i >= 0; i--) {
      uint8_t m = (tx[w] >> i) & 1, s = (rx[w] >> i) & 1;
      spiStep(clk, mosi, miso, 0, m, s, half); // data set up
      spiStep(clk, mosi, miso, 1, m, s, half); // sampled on the rise
    }
  }
  spiStep(clk, mosi, miso, 0, 0, 0, half * 2);
  origin = clk.pos + usToSamples(GAP_US);

  // D4/D5: I2C write then read, 6us per half-bit (~83 kHz).
  const double halfBit = 6;
  Pen scl(4, origin), sda(5, origin);
  const uint8_t wr[] = {(0x50 << 1) | 0, 0x00, 0x42};
  const uint8_t rd[] = {(0x50 << 1) | 1, 0xab, 0xcd};
  i2cTransaction(scl, sda, wr, 3, halfBit);
  i2cPhase(scl, sda, 1, 1, 30);
  i2cTransaction(scl, sda, rd, 3, halfBit);
  origin = scl.pos + usToSamples(GAP_US);

  // D6: 1-Wire READ ROM then SKIP ROM.
  Pen d6(6, origin);
  const uint8_t ow[] = {0x33, 0xcc};
  oneWireBytes(d6, ow, 2);
  origin = d6.pos + usToSamples(GAP_US);

  // D7: two CAN frames at 100 kbit/s.
  Pen d7(7, origin);
  const uint8_t f1[] = {0xde, 0xad}, f2[] = {0x55};
  canFrame(d7, 0x123, f1, 2, 10);
  canFrame(d7, 0x7a5, f2, 1, 10);

  return d7.pos + usToSamples(GAP_US);
}

} // namespace detail

/** Length of one whole demo cycle at `rate` Hz, in samples. */
static uint32_t cycleLength(uint32_t rate) {
  detail::buffer = nullptr;
  detail::bufferLen = 0;
  detail::rate = rate;
  return detail::buildCycle();
}

/**
 * Build one whole demo cycle at `rate` Hz into a malloc'd buffer, truncated at
 * `cap` samples so a high rate can't exhaust the heap (beyond it the cycle is
 * cut short, not refused). Returns null if the allocation fails; `*lenOut` is
 * the length in samples. The caller owns the buffer.
 */
static uint8_t *build(uint32_t rate, uint32_t cap, uint32_t *lenOut) {
  uint32_t cycle = cycleLength(rate); // sizing pass: no buffer, just the length
  uint32_t want = cycle > cap ? cap : cycle;
  if (want < 1) want = 1;

  uint8_t *out = (uint8_t *)malloc(want);
  *lenOut = 0;
  if (!out) return nullptr;

  detail::buffer = out;
  detail::bufferLen = want;
  memset(out, IDLE_BYTE, want);
  detail::buildCycle(); // for real this time, truncated at `want`
  detail::buffer = nullptr;

  *lenOut = want;
  return out;
}

} // namespace demo
