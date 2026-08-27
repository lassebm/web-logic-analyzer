# SUMP device emulator

A throwaway ESP32 firmware that pretends to be a SUMP/OLS logic analyzer, so the
app's **SUMP/OLS (serial)** backend can be exercised without owning one.

It doesn't sample any pins. On `RUN` it **synthesizes the same signals as the
app's built-in demo capture** — UART on D0, SPI on D1–D3, I²C on D4/D5, 1-Wire on
D6, CAN on D7 — and uploads them newest-sample-first, the way the protocol says.

That makes the whole path self-checking. The pattern is generated from timings in
microseconds and converted using whatever sample rate the host asked for, so every
protocol keeps its real-world bit rate at any rate you pick. So:

- if the host **reversed the dump**, Detect finds nothing and the decoders are
  silent — the single highest-risk defect, visible immediately;
- if the host **mislabelled the divider-resolved rate**, the UART decodes at the
  wrong baud and the CAN frames come out at the wrong bit rate;
- if the host **skipped the `0x82` flags byte**, the sample stream desynchronizes.

At 1 MHz the firmware's output is byte-for-byte identical to the app's own demo
capture (the generator lives in `tools/common/demo_pattern.h`, shared with the
FX2 emulator next door), so **Load demo capture** from the **?** menu is your
reference picture: capture from the device and you should get the same waveform.

## Flashing

Needs [PlatformIO Core](https://platformio.org/install/cli) — `brew install platformio`,
or `pip install platformio`.

```bash
cd tools/sump-emulator
pio run -e c3 -t upload
```

The first build downloads the ESP32 platform and toolchain (~400 MB, about a
minute and a half). After that a rebuild is a few seconds.

Pick the env for your board and the persona you want — `c3` is the default:

```bash
pio run -e s3      -t upload    # ESP32-S3
pio run -e esp32   -t upload    # classic ESP32, via its USB-UART bridge
pio run -e c3-ols  -t upload    # same C3, pretending to be an OLS
```

Switching persona means reflashing; they are compile-time build flags, not a
runtime setting.

### Picking the port

PlatformIO auto-detects a single attached board. List what it can see with:

```bash
pio device list
```

A C3 or S3 on its native USB appears as an Espressif `USB JTAG/serial debug
unit` — VID:PID `303A:1001`, and on macOS a `/dev/cu.usbmodem*` node. A classic
ESP32 shows up as its bridge chip instead (`/dev/cu.usbserial-*` or
`/dev/cu.SLAB_USBtoUART`). If more than one board is plugged in, name the one you
want:

```bash
pio run -e c3 -t upload --upload-port /dev/cu.usbmodem2101
```

### If the upload doesn't take

- **Something else is holding the port.** Only one program can own it: close the
  browser tab that connected to it (or hit **Disconnect** first), and quit any
  `pio device monitor` / serial terminal. This is the usual cause.
- **The board isn't entering the bootloader.** Hold **BOOT**, tap **RESET**,
  release **BOOT**, then upload. Needed more often on classic ESP32 boards than
  on the C3/S3, whose native USB resets itself.
- **Something is genuinely wedged.** `pio run -e c3 -t erase` wipes the flash;
  `-t erase_upload` wipes and reflashes in one go.

### Other useful targets

```bash
pio run -e c3 -t clean     # drop this env's build directory
pio run -e c3 -t size      # flash / RAM usage
pio device monitor         # raw serial — see the note below before using it
```

`pio device monitor` opens the same port the app wants, and the traffic is
binary SUMP, not text — so it is only useful for confirming the board is alive.
**Close it before connecting from the browser.**

### Two PlatformIO behaviours worth knowing

- `pio run` with no `-e` builds only `default_envs` (`c3`), not every env. Pass
  `-e` explicitly for the others.
- Editing `platformio.ini` invalidates the _other_ envs' build directories, so
  they get rebuilt from scratch the next time you name them.

## Using it

1. `npm run dev`, open <http://127.0.0.1:5173>.
2. Set **Device** to **SUMP/OLS (serial)**, click **Connect device**, pick the
   board's port.
3. The device label should read back the persona's name, and the sample-rate and
   sample-count lists should reflect what it reported.
4. Set **Sample rate** to **1 MHz**, **Samples** to **16,384** for the whole cycle
   at once (see below), then **Run**. Or set **Captures** to 5 with **2,048**
   samples to walk through the cycle a couple of protocols at a time.

### Captures tile through the cycle

One full demo cycle is **6512 samples at 1 MHz**, and the protocols play one after
another rather than together. Each capture starts where the previous one ended, so
consecutive captures walk through the cycle instead of being identical — which is
what re-arming on a free-running bus really looks like, and the only way the app's
**Capture** pager shows you anything.

So the sample count decides how much of the cycle you see at once:

| Samples @ 1 MHz | One capture holds                |
| --------------- | -------------------------------- |
| 2,048           | roughly two protocols            |
| 16,384          | the whole cycle, then it repeats |

With **Captures: 5** at 2,048 samples you get five different views — measured, they
land like this:

```
capture 1: UART, SPI, I²C      capture 4: UART, SPI, CAN
capture 2: I²C, 1-Wire         capture 5: I²C, 1-Wire
capture 3: 1-Wire, CAN
```

The first capture after a reset always starts at offset 0, so it matches **Load demo
capture** exactly and stays usable as a correctness check. The window scales with the
rate: at 4 MHz a cycle is ~26 k samples, so multiply accordingly. If CAN looks
missing from a single short capture, this is why — it is last in the cycle (samples
5052–6191 at 1 MHz).

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

Export to VCD and re-import it to check that path too.

## Personas

Each env emulates a different device, to reach a different branch of the driver.
The names are chosen to match the app's own profile rows (`src/sump/profiles.ts`).

| Env       | Emulates                                     | What it exercises                                    |
| --------- | -------------------------------------------- | ---------------------------------------------------- |
| `c3`      | ESP32-Bit-Pirate (default)                   | No hardware trigger; the app's software trigger path |
| `c3-ols`  | Open Logic Sniffer v1.01                     | Hardware level trigger, 24 KiB depth                 |
| `c3-bare` | A device that answers the ID but not `0x04`  | The generic-profile fallback                         |
| `c3-deep` | A 1 MiB device                               | The 32-bit count commands (`0x84`/`0x83`)            |
| `s3`      | as `c3`, on an ESP32-S3                      |                                                      |
| `esp32`   | as `c3`, on a classic ESP32 (via its bridge) |                                                      |

Build flags in `platformio.ini` set all of it; see the `DEV_*` defines at the top
of `src/main.cpp` if you want a persona of your own.

### The bug it reproduces on purpose

The default persona sets `DEV_BUGGY_LONG_CMDS=1`, which copies a real
ESP32-Bit-Pirate defect: an unknown opcode ≥ 0x80 is dropped _without consuming
its 4 payload bytes_, so those bytes get read as commands and the rest of the arm
sequence is misparsed. A host that never sends an unknown long command never
notices — which is exactly what it's here to prove. Set it to `0` for a
spec-correct device.

## Things worth knowing

- **`c3-ols` with a trigger that never fires stays silent**, as real hardware
  does — the case the app's **Stop** button has to get you out of, and worth
  trying deliberately. The protocols play one after another, so any two-channel
  level condition spanning different windows can never hold at once: set
  **D0 → Low** and **D4 → Low** (UART and I²C SCL, measured 0 samples in common)
  and the device arms and waits forever. Use a _level_ condition, not an edge —
  edges are resolved from the samples afterwards and never make the device wait.
- **A rate far below a protocol's bit rate produces nonsense**, exactly as it
  would with real hardware — 115200 baud UART can't survive 100 kHz sampling.
  The app warns about this. What is _not_ a limit any more is an awkward ratio:
  every edge is placed from its absolute time, so the pattern holds its real bit
  rates at any rate rather than only at the ones that divide evenly. The demo
  UART reads back cleanly from ~230 kHz up (measured); 1–4 MHz is still the
  easiest place to look at everything.
- **Above ~10 MHz the demo cycle is truncated** to a 96 KiB pattern buffer, so
  you see part of a cycle repeated rather than the whole thing. The protocols
  still decode; there's just less of them.
- **With a hardware trigger persona (`c3-ols`) the trigger looks forward** from
  wherever the signal has got to, so it fires on the next occurrence rather than
  always the same one.
- The firmware waits out the capture time before uploading, like a real device
  filling its own memory, so the app's "capturing into the device's memory…"
  status is real rather than instant. Capped at 10 s.
- Nothing here is built or linted by the web app: `tsconfig`, Vite and ESLint all
  scope to `src/`.
