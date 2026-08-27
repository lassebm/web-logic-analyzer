# FX2 device emulator

A throwaway ESP32-S3 / ESP32-S2 firmware that pretends to be an FX2 logic analyzer running
`fx2lafw`, so the app's **FX2 (USB)** backend can be exercised without owning
one. It enumerates as a vendor-class USB device, answers the fx2lafw vendor
commands, and streams samples out of a bulk IN endpoint.

It doesn't sample any pins. On `CMD_START` it **synthesizes the same signals as
the app's built-in demo capture** — UART on D0, SPI on D1–D3, I²C on D4/D5,
1-Wire on D6, CAN on D7 — and streams them continuously, the way an FX2 does.

That makes the whole path self-checking. The pattern is generated from timings in
microseconds and laid out at whatever rate the host's three `CMD_START` bytes
_actually resolve to_ — clock bit and divider decoded here, not taken on trust —
so every protocol keeps its real-world bit rate at any rate you pick. So:

- if the host **mislabels the rate** it asked for, the UART decodes at the wrong
  baud and the CAN frames come out at the wrong bit rate;
- if the host **assumes the endpoint address** instead of reading it out of the
  descriptor, no samples arrive at all (the `s3-ep1` persona);
- if the host **lets its transfer queue drain**, the emulator's throughput log
  shows the gaps.

At 1 MHz the firmware's output is byte-for-byte identical to the app's own demo
capture (the pattern generator is shared with the SUMP emulator and lives in
`tools/common/demo_pattern.h`), so **Load demo capture** from the **?** menu is
your reference picture: capture from the device and you should get the same
waveform.

## Boards

**ESP32-S3 or ESP32-S2 only.** Being a USB _device_ of our own design needs the
USB-OTG peripheral and custom descriptors; the C3's USB is a fixed-function
serial/JTAG bridge and a classic ESP32 has no USB at all. That is why the SUMP
emulator next door runs on more boards than this one does — it only needs a
serial port.

Every persona below is built for both chips: `s3-…` for an S3-DevKitC-1,
`s2-…` for an S2-Saola-1. Another board of either chip is a one-line
`board =` change in `platformio.ini`; nothing in a persona depends on it.

Both boards carry two USB sockets and this uses both:

| Socket   | What it is            | Used for                                    |
| -------- | --------------------- | ------------------------------------------- |
| **UART** | the CP2102 bridge     | flashing, and the emulator's own log        |
| **USB**  | the chip's native USB | the emulated FX2 — this is what Chrome sees |

Keep both plugged in: `pio device monitor` on the UART port shows you what the
app is doing to the device while the browser drives the other socket.

## Flashing

Needs [PlatformIO Core](https://platformio.org/install/cli) — `brew install platformio`,
or `pip install platformio`.

```bash
cd tools/fx2-emulator
pio run -e s3 -t upload
```

The first build downloads the ESP32 platform and toolchain (~400 MB, about a
minute and a half). After that a rebuild is a few seconds.

Pick the env for the persona you want — `s3` is the default:

```bash
pio run -e s3-stock -t upload   # a stock Cypress FX2, needing firmware
pio run -e s3-stall -t upload   # one that dies mid-capture
pio run -e s3-tick  -t upload   # one UART line a second, for the live views
```

On an **S2**, swap the prefix — `s2`, `s2-stock`, `s2-ep1`, `s2-stall`,
`s2-oldfw` are the same personas on that chip. If it's the only board you have,
set `default_envs = s2` in `platformio.ini` and drop the `-e` entirely.

Switching persona means reflashing; they are compile-time build flags, not a
runtime setting.

### Picking the port

Upload over the **UART** socket — `/dev/cu.usbserial-*` or `/dev/cu.SLAB_USBtoUART`
on macOS. PlatformIO auto-detects a single attached board; with several plugged
in, list them with `pio device list` and name the one you want:

```bash
pio run -e s3 -t upload --upload-port /dev/cu.usbserial-10
```

The native **USB** socket is not a serial port here — this firmware puts it in
TinyUSB mode, where it enumerates as our vendor-class device rather than as a
CDC port. To flash over that socket instead, hold **BOOT**, tap **RESET**,
release **BOOT** to get the ROM bootloader back, then upload.

### Watching the log

```bash
pio device monitor -p /dev/cu.usbserial-10
```

Every connect, firmware upload, `CMD_START` and a once-a-second throughput line
land here, along with `!!` lines for anything the host does that real hardware
would not survive.

## Using it

1. `npm run dev`, open <http://127.0.0.1:5173>.
2. Set **Device** to **FX2 (USB)**, click **Connect device**, and pick
   **fx2lafw** from Chrome's list.
3. The device label should read `fx2lafw — fw 1.3, rev 2`.
4. Set **Sample rate** to **1 MHz**, **Samples** to **10,000**, then **Run**.

The demo cycle is **6512 samples at 1 MHz** and repeats for as long as you
capture, so 10,000 samples gets you one whole cycle and a bit of the next. The
capture starts at the top of the cycle every time, which is what makes it
comparable with **Load demo capture**.

### Decoder settings

**Detect** finds the UART on D0 and the I²C bus on D4/D5 and wires them up for
you. The rest have to be added by hand, and two of them need a setting changed
off its default — a decoder left on its default will sit there decoding nothing:

| Decoder | Channels                 | Setting                                     |
| ------- | ------------------------ | ------------------------------------------- |
| UART    | D0                       | 115200 8-N-1 — all defaults                 |
| ASCII   | stacked on the UART      | defaults                                    |
| SPI     | CLK D1, MOSI D2, MISO D3 | **CS polarity → `none`** (no CS wire)       |
| I²C     | SCL D4, SDA D5           | defaults                                    |
| 1-Wire  | D6                       | defaults                                    |
| CAN     | D7                       | **Bit rate → `100000`** (default is 500000) |

Raising the sample rate will not fix a wrong bit rate: the firmware keeps every
protocol at its real-world timing whatever rate you sample at, so the CAN frames
are 100 kbit/s at 1 MHz and still 100 kbit/s at 4 MHz.

Loading **? → Load demo capture** gives you the same signals with all six
decoders pre-wired, which makes a useful side-by-side reference.

### What only this backend can show you

The SUMP emulator can't reach any of this — a SUMP device fills its own memory
and only then uploads, so the app marks it non-streaming:

The `tick` persona is the one to flash for these: the demo cycle is 6.5 ms long,
so it repeats faster than a live view can show you anything.

- **Follow** — the rolling live view, on while the capture runs.
- **Serial Monitor** — point it at D0 and watch `Hello` lines arrive as they are
  sampled. It captures at its own rate with small, low-latency transfers, which
  is a different shape of traffic from a Run.
- **Live in-view decoding**, and captures that keep rolling across a multi-capture
  Run.

## Personas

Each env emulates a different device, to reach a different branch of the driver.
The S3 envs are listed; every one has an `s2-` twin, identical but for the chip.

| Env        | Emulates                                      | What it exercises                                    |
| ---------- | --------------------------------------------- | ---------------------------------------------------- |
| `s3`       | sigrok FX2 LA (8ch) running fx2lafw (default) | Connect, capture, Follow, Serial Monitor             |
| `s3-stock` | a stock Cypress FX2 (`04b4:8613`)             | Firmware upload, re-enumeration, "Finish connecting" |
| `s3-ep1`   | as `s3`, samples on EP 0x81                   | That the endpoint address comes from the descriptor  |
| `s3-stall` | as `s3`, silent after 256 KiB                 | The stall watchdog, and keeping the partial capture  |
| `s3-oldfw` | a device running fx2lafw 0.4                  | The version check, which must refuse it              |
| `s3-tick`  | as `s3`, but one UART line a second           | Follow, the Serial Monitor, live decode over silence |

Build flags in `platformio.ini` set all of it; see the `DEV_*` defines at the top
of `src/main.cpp` if you want a persona of your own. Old fx2lafw's other endpoint
address, 0x86, is not among them: the S2/S3 have IN endpoints 1–4 only.

### The firmware-upload persona

`s3-stock` boots with no firmware, on the identity the app knows as **Cypress
FX2**, and the first connect walks the whole provisioning path:

1. The app finds no `sigrok`/`fx2lafw` string descriptors, so it uploads its
   bundled `fx2lafw-cypress-fx2.fw` — 8051 held in reset, image written in 4 KiB
   chunks to ascending addresses, reset released. Each step prints to the log,
   and anything out of order prints `!!`. Nothing is kept: there is no 8051 here,
   and the bytes are only good for checking the host.
2. Releasing the reset "boots the firmware" — the board reboots into the
   `1d50:608c` sigrok/fx2lafw identity, which to the host is a re-enumeration.
3. **The first time, expect “Finish connecting”.** WebUSB permission is granted
   per VID:PID, so a device that comes back as a _different_ id was never granted
   and `getDevices()` won't surface it. Click the button, pick **fx2lafw**, and
   from then on the reconnect is automatic — exactly what happens with real
   hardware.

The FX2 keeps its firmware in RAM, so this emulator forgets it on a power cycle
or a **RESET** press, and is back to needing an upload. Only the reboot it does
itself carries the loaded state over.

### The tick persona

`s3-tick` / `s2-tick` drop the demo cycle. D0 carries a single UART line a
second — `tick 1`, `tick 2`, `tick 3`, … at 115200 8-N-1 — and every channel
sits at its idle level in between. That is the signal the live features are
about: a capture spans real wall-clock time, mostly quiet, with something
arriving in it while you watch.

- **Follow** scrolls through the idle and catches each line as it lands.
- **Serial Monitor** on D0 fills one line at a time, about one a second.
- **Live in-view decoding** has long stretches of nothing to survive, which is
  the case that a decoder restricted to the on-screen window has to get right.
- The **counter** is what makes a dropped or duplicated stretch visible: the
  lines are numbered, so a gap in them is a gap in the capture. It restarts at
  `tick 1` on every Run.

Only the UART matters here — leave the other decoders off. 1 MHz is a good rate.
The line is laid out from absolute time like the demo pattern is, so it decodes
at any rate from **250 kHz up**; below about two samples per bit it is still in
the samples but no longer readable, and the log says so.

Change the interval or the text with the build flags in `platformio.ini`:
`-DDEV_TICK_MS=250`, `-DDEV_TICK_TEXT='"hello"'`, `-DDEV_TICK_BAUD=9600`.

## Things worth knowing

- **Full-speed USB is the ceiling.** The S2/S3 are USB 1.1 full-speed (12 Mbit/s
  on the wire) where a real FX2 is high-speed, so above a few hundred kHz the
  link, not the sample rate, decides how fast samples arrive. The emulator paces
  itself to the rate you asked for whenever it can keep up, and simply falls
  behind when it can't: the samples are unaffected, but the capture takes longer
  in wall-clock than it would on real hardware, and the live view crawls. The
  log's `kB/s (asked …)` line is how you tell which side of that you are on.
- **A rate the link can't feed ends in the app's stall message.** The host gives
  up after a few seconds of silence, keeps the partial capture, and suggests a
  lower rate — which for a real FX2 would be the right advice. That is the same
  path `s3-stall` reproduces deliberately.
- **Above ~10 MHz the demo cycle is truncated** to a 96 KiB pattern buffer, so you
  see part of a cycle repeated rather than the whole thing. The protocols still
  decode; there's just less of them.
- **A rate far below a protocol's bit rate produces nonsense**, exactly as it
  would with real hardware — 115200 baud UART can't survive 100 kHz sampling.
  The app warns about this; 1–4 MHz shows everything cleanly.
- **The 16-bit capture mode isn't emulated.** The app never asks for it (it
  captures in fx2lafw's 8-bit mode); if something ever does, the log says so and
  the emulator keeps streaming 8-bit.
- **Unknown control requests stall**, as an FX2 would, including `0xa0` once the
  device is "running fx2lafw": the bootloader is gone at that point.
- **No WebUSB landing page.** Advertising one makes Chrome offer to open a URL
  every time the device is plugged in, which gets old fast on a bench tool. A
  real FX2 advertises neither that nor the MS-OS descriptors that come with it in
  this core, so on **Windows** this needs WinUSB bound by hand (Zadig) — the same
  thing real hardware needs, and what the app's own README documents.
- Nothing here is built or linted by the web app: `tsconfig`, Vite and ESLint all
  scope to `src/`.
