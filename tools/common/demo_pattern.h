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

/** A write head on one channel: where it is, and which bit it owns. */
struct Pen {
  uint8_t ch;
  uint32_t pos;
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

static void putUs(Pen &p, uint8_t level, double us) {
  put(p, level, usToSamples(us));
}

/** 8-N-1, LSB-first, idle high. */
static void uartByte(Pen &p, uint8_t b, uint32_t spb) {
  put(p, 1, spb * 2);
  put(p, 0, spb);
  for (int i = 0; i < 8; i++) put(p, (b >> i) & 1, spb);
  put(p, 1, spb * 2);
}

/** 3-wire SPI, CPOL0/CPHA0, MSB-first, sampled on the rising edge. */
static void spiStep(Pen &clk, Pen &mosi, Pen &miso, uint8_t c, uint8_t m,
                    uint8_t s, uint32_t n) {
  put(clk, c, n);
  put(mosi, m, n);
  put(miso, s, n);
}

/** One I2C phase: hold SCL and SDA for one half-bit. */
static void i2cPhase(Pen &scl, Pen &sda, uint8_t c, uint8_t d, uint32_t n) {
  put(scl, c, n);
  put(sda, d, n);
}

static void i2cBit(Pen &scl, Pen &sda, uint8_t bit, uint32_t n) {
  i2cPhase(scl, sda, 0, bit, n); // SCL low, set up SDA
  i2cPhase(scl, sda, 1, bit, n); // SCL high -> bit sampled
}

static void i2cTransaction(Pen &scl, Pen &sda, const uint8_t *bytes, int count,
                           uint32_t n) {
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

  // D0: UART "Hello\n" at 115200 8-N-1.
  const uint32_t spb = usToSamples(1000000.0 / 115200.0);
  Pen d0{0, origin};
  for (const char *s = "Hello\n"; *s; s++) uartByte(d0, (uint8_t)*s, spb);
  origin = d0.pos + usToSamples(GAP_US);

  // D1-D3: SPI, 8us per half-bit (~62.5 kHz).
  const uint32_t half = usToSamples(8);
  Pen clk{1, origin}, mosi{2, origin}, miso{3, origin};
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
  const uint32_t halfBit = usToSamples(6);
  Pen scl{4, origin}, sda{5, origin};
  const uint8_t wr[] = {(0x50 << 1) | 0, 0x00, 0x42};
  const uint8_t rd[] = {(0x50 << 1) | 1, 0xab, 0xcd};
  i2cTransaction(scl, sda, wr, 3, halfBit);
  i2cPhase(scl, sda, 1, 1, usToSamples(30));
  i2cTransaction(scl, sda, rd, 3, halfBit);
  origin = scl.pos + usToSamples(GAP_US);

  // D6: 1-Wire READ ROM then SKIP ROM.
  Pen d6{6, origin};
  const uint8_t ow[] = {0x33, 0xcc};
  oneWireBytes(d6, ow, 2);
  origin = d6.pos + usToSamples(GAP_US);

  // D7: two CAN frames at 100 kbit/s.
  Pen d7{7, origin};
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
