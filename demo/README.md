# Demo capture

`all-signals.vcd` is a synthetic capture with one short exchange on each
supported protocol — so you can explore the app (waveform, decoders,
auto-detect, export) **without any hardware**.

You don't need this file to try the demo: in the app, open the **?** (Help) menu
in the top bar and click **Load demo capture**, which loads the same data and
adds every decoder pre-wired. The file is here for opening in other tools
(PulseView, GTKWave) or importing via **Import → VCD**.

Each protocol plays in its own time window (one after another), so scrolling the
waveform shows them without overlap.

## Channel map

| Channel | Signal                                     | Decoder to add                     |
| ------- | ------------------------------------------ | ---------------------------------- |
| D0      | UART TX — `"Hello\n"`, 115200 8-N-1        | UART, baud 115200                  |
| D1–D3   | SPI CLK / MOSI / MISO                      | SPI, chip select **none** (3-wire) |
| D4 / D5 | I²C SCL / SDA — a write then a read        | I²C                                |
| D6      | 1-Wire — reset, presence, `0x33`, `0xCC`   | 1-Wire                             |
| D7      | CAN RX — two frames (IDs `0x123`, `0x7A5`) | CAN, bit rate 100 kbit             |

## Auto-detect

Clicking **Detect** reliably finds the two self-describing protocols and wires
them correctly: **UART on D0** and **I²C on D4/D5** (it even works out which of
the two I²C lines is the clock).

It may also offer the SPI clock/data and CAN lines as _possible_ UART — any
NRZ-serial line can resemble UART when viewed on its own, so that's expected.
SPI, 1-Wire, and CAN aren't auto-detected; add those from the decoder panel
using the map above.
