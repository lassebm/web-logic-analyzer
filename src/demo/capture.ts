/**
 * Synthetic demo capture carrying one short exchange on each supported protocol,
 * so the app can be explored with no hardware. Protocols play *one after another*
 * in their own time window (see the channel map below): this reads clearly when
 * scrolling the waveform and keeps idle channels from coincidentally mimicking a
 * bus during another protocol's activity.
 *
 * Channel map (each protocol on its own lines; the two auto-detectable ones —
 * UART and I²C — are kept on separate channels):
 *
 * | Ch     | Signal                         |
 * |--------|--------------------------------|
 * | D0     | UART TX ("Hello\n", 115200 8N1)|
 * | D1..D3 | SPI CLK / MOSI / MISO (3-wire) |
 * | D4/D5  | I²C SCL / SDA                  |
 * | D6     | 1-Wire                         |
 * | D7     | CAN RX                         |
 *
 * The builders here are deliberately self-contained (they don't reach into the
 * test helpers) so the demo ships as ordinary app code.
 */
import { CaptureBuffer } from "../model/capture";

/** 1 sample/µs — natural units for the 1-Wire timings, ample for the rest. */
export const DEMO_SAMPLE_RATE = 1_000_000;

/** Per-channel idle levels (D0..D7). */
const IDLE = [1, 0, 0, 0, 1, 1, 1, 1];
/** Idle samples framing each protocol's window. */
const GAP = 200;

/** Decoders the "Load demo" action adds, pre-wired to the channel map above. */
export const DEMO_DECODERS: Array<{
  decoderId: string;
  channelMap: number[];
  options: Record<string, string | number>;
}> = [
  { decoderId: "uart", channelMap: [0], options: { baudrate: 115200 } },
  // Stacked on the UART above (auto-wired by loadDemo, since it is added right
  // after): turns the UART bytes into readable text ("Hello\n").
  { decoderId: "ascii", channelMap: [], options: {} },
  { decoderId: "spi", channelMap: [1, 2, 3], options: { cs_polarity: "none" } },
  { decoderId: "i2c", channelMap: [4, 5], options: {} },
  { decoderId: "onewire", channelMap: [6], options: {} },
  { decoderId: "can", channelMap: [7], options: { bitrate: 100000 } },
];

// --- Per-channel level builders (0/1 arrays) -------------------------------

function repeat(out: number[], value: number, count: number): void {
  for (let i = 0; i < count; i++) out.push(value);
}

/** One UART frame (8-N-1, LSB-first, idle high), `spb` samples per bit. */
function uartFrame(out: number[], byte: number, spb: number): void {
  repeat(out, 1, spb * 2); // idle
  repeat(out, 0, spb); // start bit
  for (let i = 0; i < 8; i++) repeat(out, (byte >> i) & 1, spb);
  repeat(out, 1, spb * 2); // stop + idle
}

function uartLevels(text: string): number[] {
  const spb = DEMO_SAMPLE_RATE / 115200;
  const out: number[] = [];
  for (const ch of text) uartFrame(out, ch.charCodeAt(0), spb);
  return out;
}

/** 3-wire SPI (CPOL0/CPHA0, MSB-first): parallel clk/mosi/miso level arrays. */
function spiLevels(mosi: number[], miso: number[], spb = 8) {
  const clk: number[] = [];
  const md: number[] = [];
  const sd: number[] = [];
  const step = (c: number, m: number, s: number, n: number) => {
    repeat(clk, c, n);
    repeat(md, m, n);
    repeat(sd, s, n);
  };
  step(0, 0, 0, spb * 2); // idle, clock low
  for (let w = 0; w < mosi.length; w++) {
    for (let i = 7; i >= 0; i--) {
      const m = (mosi[w] >> i) & 1;
      const s = (miso[w] >> i) & 1;
      step(0, m, s, spb); // clock low, data set up
      step(1, m, s, spb); // clock high -> sampled on the rising edge
    }
  }
  step(0, 0, 0, spb * 2);
  return { clk, mosi: md, miso: sd };
}

/** I²C SCL/SDA arrays for one transaction (idle, START, bytes+ACK, STOP). */
function i2cTransaction(bytes: number[], spb = 6) {
  const scl: number[] = [];
  const sda: number[] = [];
  const phase = (c: number, d: number) => {
    repeat(scl, c, spb);
    repeat(sda, d, spb);
  };
  const clockBit = (bit: number) => {
    phase(0, bit); // SCL low, set up SDA
    phase(1, bit); // SCL high -> bit sampled
  };
  repeat(scl, 1, spb * 2);
  repeat(sda, 1, spb * 2); // idle: both high
  phase(1, 0); // START: SDA falls while SCL high
  for (const b of bytes) {
    for (let i = 7; i >= 0; i--) clockBit((b >> i) & 1);
    clockBit(0); // ACK
  }
  phase(0, 0); // STOP setup
  phase(1, 0);
  repeat(scl, 1, spb);
  repeat(sda, 1, spb); // SDA rises while SCL high
  repeat(scl, 1, spb * 2);
  repeat(sda, 1, spb * 2);
  return { scl, sda };
}

/** Two back-to-back I²C transactions: a write, then a read. */
function i2cLevels() {
  const w = i2cTransaction([(0x50 << 1) | 0, 0x00, 0x42]); // write 0x00,0x42
  const gap = new Array(30).fill(1);
  const r = i2cTransaction([(0x50 << 1) | 1, 0xab, 0xcd]); // read 0xAB,0xCD
  return {
    scl: [...w.scl, ...gap, ...r.scl],
    sda: [...w.sda, ...gap, ...r.sda],
  };
}

/** 1-Wire: reset, presence, then bytes LSB-first (short low = 1, long low = 0). */
function oneWireLevels(bytes: number[]): number[] {
  const SLOT = 70;
  const out: number[] = [];
  repeat(out, 1, 100); // idle
  repeat(out, 0, 500); // reset (>= 300µs)
  repeat(out, 1, 50); // recovery
  repeat(out, 0, 120); // presence pulse
  repeat(out, 1, 50);
  for (const byte of bytes) {
    for (let i = 0; i < 8; i++) {
      const low = (byte >> i) & 1 ? 5 : 60;
      repeat(out, 0, low);
      repeat(out, 1, SLOT - low);
    }
    repeat(out, 1, 40); // inter-byte recovery
  }
  repeat(out, 1, 100);
  return out;
}

/** Classical CAN standard data frame (dominant=0/recessive=1), 5-bit stuffed. */
function canStdFrame(id: number, data: number[], spb = 10): number[] {
  const logical: number[] = [];
  logical.push(0); // SOF
  for (let i = 10; i >= 0; i--) logical.push((id >> i) & 1); // 11-bit ID
  logical.push(0); // RTR (data frame)
  logical.push(0); // IDE (standard)
  logical.push(0); // r0
  for (let i = 3; i >= 0; i--) logical.push((data.length >> i) & 1); // DLC
  for (const b of data) for (let i = 7; i >= 0; i--) logical.push((b >> i) & 1);
  for (let i = 14; i >= 0; i--) logical.push((0x2aaa >> i) & 1); // CRC (unverified)

  const stuffed: number[] = [];
  let prev = -1;
  let run = 0;
  for (const b of logical) {
    stuffed.push(b);
    if (b === prev) run++;
    else {
      prev = b;
      run = 1;
    }
    if (run === 5) {
      const s = prev ^ 1;
      stuffed.push(s);
      prev = s;
      run = 1;
    }
  }
  stuffed.push(1, 0, 1, 1, 1, 1, 1, 1, 1, 1); // CRC delim, ACK, ACK delim, EOF

  const out: number[] = [];
  repeat(out, 1, 40); // idle recessive
  for (const b of stuffed) repeat(out, b, spb);
  repeat(out, 1, 40);
  return out;
}

// --- Assembly --------------------------------------------------------------

/** One protocol's window: channel -> level array, all padded to equal length. */
function segment(entries: Array<{ ch: number; lv: number[] }>) {
  const len = Math.max(...entries.map((e) => e.lv.length));
  const byCh = new Map<number, number[]>();
  for (const e of entries) {
    const padded = e.lv.slice(0, len);
    while (padded.length < len) padded.push(IDLE[e.ch]);
    byCh.set(e.ch, padded);
  }
  return { len, byCh };
}

/** Build the demo capture: all supported protocols, one after another. */
export function buildDemoCapture(): CaptureBuffer {
  const spi = spiLevels([0x9f, 0xa5, 0x3c], [0xef, 0x5a, 0xc3]);
  const i2c = i2cLevels();

  const segs = [
    segment([{ ch: 0, lv: uartLevels("Hello\n") }]),
    segment([
      { ch: 1, lv: spi.clk },
      { ch: 2, lv: spi.mosi },
      { ch: 3, lv: spi.miso },
    ]),
    segment([
      { ch: 4, lv: i2c.scl },
      { ch: 5, lv: i2c.sda },
    ]),
    segment([{ ch: 6, lv: oneWireLevels([0x33, 0xcc]) }]), // READ ROM, SKIP ROM
    segment([
      {
        ch: 7,
        lv: [
          ...canStdFrame(0x123, [0xde, 0xad]),
          ...canStdFrame(0x7a5, [0x55]),
        ],
      },
    ]),
  ];

  const n = GAP + segs.reduce((t, s) => t + s.len + GAP, 0);
  const bytes = new Uint8Array(n);

  // Start every channel at its idle level across the whole timeline.
  for (let s = 0; s < n; s++)
    for (let ch = 0; ch < 8; ch++) if (IDLE[ch]) bytes[s] |= 1 << ch;

  // Overlay each protocol's waveform into its window; other channels stay idle.
  let pos = GAP;
  for (const seg of segs) {
    for (const [ch, lv] of seg.byCh) {
      for (let k = 0; k < seg.len; k++) {
        if (lv[k]) bytes[pos + k] |= 1 << ch;
        else bytes[pos + k] &= ~(1 << ch);
      }
    }
    pos += seg.len + GAP;
  }

  const buf = new CaptureBuffer(DEMO_SAMPLE_RATE, n);
  buf.append(bytes);
  return buf;
}
