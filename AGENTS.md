# AGENTS.md

Guidance for AI agents and contributors working in this repository.

## Project

**Web Logic Analyzer** — a browser-based logic analyzer that drives real hardware
from the page: FX2 (`fx2lafw`) devices over **WebUSB**, and SUMP/OLS devices
(Open Bench Logic Sniffer, Bus Pirate, ESP32 Bit Pirate, …) over **Web Serial**.
It uploads firmware where needed, captures 8 digital channels, visualizes them,
and decodes protocols. No native install.

Stack: **Svelte 5 (runes: `$state`/`$derived`/`$props`) + Vite + TypeScript**.
Waveform rendered on `<canvas>`.

## Commands

Scripts are in `package.json`. Two things it doesn't tell you:

- `npm run dev` serves on `http://127.0.0.1:5173` — localhost is a secure context, so
  WebUSB and Web Serial work there.
- Before finishing any change: `npm run check`, `npm test`, and `npm run lint` must
  pass; formatting must be clean (`npm run format:check`); and `npm run build` should
  succeed.
- No hardware? `tools/` holds an ESP32 firmware per backend that pretends to be a
  device and synthesizes the demo capture's signals — the generator is shared
  (`tools/common/demo_pattern.h`) and byte-identical to `demo/` at 1 MHz, so both
  emulators can be checked against **Load demo capture**. Each has a build persona
  per driver branch: `sump-emulator/` covers the hardware trigger, the
  generic-profile fallback, 32-bit counts and ESP32-Bit-Pirate's
  unknown-long-opcode bug; `fx2-emulator/` (S2/S3 only — it needs USB-OTG) covers
  the firmware upload and re-enumeration, a non-0x82 sample endpoint, a stalled
  stream, a rejected firmware version, and — in place of the demo cycle, whose
  6.5 ms says nothing about a view that scrolls — one numbered UART line a
  second, which is the signal Follow and the Serial Monitor are for. Not part of the web app's build:
  `tsconfig`, Vite and ESLint all scope to `src/`.

## Architecture (`src/`)

Module map — one line per directory, with the couplings and invariants the code
alone won't teach you. Read the files for the actual APIs.

- `device/` — the hardware-agnostic seam. `types.ts` is the contract
  (`DeviceBackend` → `LogicDevice` → `Acquisition`, plus `DeviceCapabilities`,
  which is what gates the toolbar options, Follow and the Serial Monitor);
  `registry.ts` lists the backends the way `decode/registry.ts` lists decoders;
  `channels.ts` owns `NUM_CHANNELS`/`CHANNEL_NAMES` (they moved out of
  `usb/constants.ts` — every layer above the transport needs them); `fx2.ts` and
  `sump.ts` are the two backends. A backend reports progress through
  `ConnectContext` and returns a `ConnectResult` rather than touching stores, so
  nothing here depends on `stores/`.
- `usb/` — WebUSB layer: device wrapper, firmware detect/upload/re-enumerate, a
  custom-firmware IndexedDB cache, the bulk-streaming capture loop, and the rate ↔ FX2
  clock-divider math plus the USB-bandwidth guard. The capture loop's transfer queue
  and stall watchdog are load-bearing — see the hardware notes below.
- `firmware/` — bundled `.fw` binaries and their loader. The loader maps filename →
  asset URL and nothing more: the VID:PID → firmware-filename map lives in
  `usb/constants.ts` (`PRE_FIRMWARE_DEVICES`), and the auto-select happens in
  `device/fx2.ts` `provision()`. The loaded custom-firmware store lives in
  `usb/firmwareState.ts`, not in `stores/session.ts`, because `device/fx2.ts`
  reads it during a connect and session imports the backend registry.
- `model/` — `CaptureBuffer` (packed samples, transition index, trimming), the
  software trigger, and activity clustering. The buffer keeps an incremental min/max
  pyramid so `channelMinMax` is O(log n) when zoomed out, plus a recent-edge ring and
  cluster tally for the live follow view — both exist to satisfy the O(chunk) rule
  below.
- `decode/` — the decoder plugin API and an edge-jumping generator runner: decoders
  `yield` wait conditions, the runner advances to the next match and calls back via
  `ctx.put`/`ctx.emit`/`ctx.pin`. `runDecoder` takes an optional sample `range` so the
  live view can decode just the window on screen. `detect/` auto-detects protocols;
  `scanChannels` scores all I²C pairs and claims strongest-first — so a weak false pair
  can't steal a real bus's line — before single-channel UART runs on what's left.
  Identifying is far more expensive than decoding — a UART costs one trial decode
  per candidate framing, so eight active channels is hundreds of passes — which is
  why `window.ts` bounds each pass to a fixed number of _edges_ rather than the
  buffer. Cost is then flat in capture length (measurements in that file); windows
  are anchored at the scanned channels' first edge and retried further along, so a
  line that only talks late is still found.
- `sump/` — the SUMP/OLS driver: `protocol.ts` (pure command encoding),
  `metadata.ts` (the `0x04` TLV parser), `profiles.ts` (fallbacks for what a
  device's metadata leaves out, plus the one thing metadata can't report —
  whether `0x83`/`0x84` exist), `serialPort.ts` (Web Serial wrapper, the analogue
  of `usb/fx2Device.ts`) and `device.ts` (identify / arm / read the dump). The
  dump arrives newest-sample-first — see the hardware notes below.
- `view/` — canvas renderer: traces, ruler, annotation lanes.
- `ui/` — Svelte components. `WaveformCanvas` coalesces redraws to one per animation
  frame. Reuse the shared pieces rather than reinventing them: `InfoTip` (ⓘ popover),
  `EditableSelect` (preset dropdown with a "Custom…" text-entry escape hatch),
  `ConfirmButton` (arm-then-commit for actions that discard something).
- `monitor/` — serial-monitor line assembly, pure/testable. Two caps bound it, both
  deliberately not user-configurable: lines and chars-per-line. A cap-split line is
  flagged `continued`, so the view can show the split while `mergeContinued` gives the
  export whole records — one definition of "one record" for both. The measurements behind
  the caps are in the comments there and in `SerialMonitor`.
- `stores/` — `session.ts` owns the selected backend (`backendId`, persisted in
  `localStorage`), the connected `LogicDevice`, its `capabilities` (never null —
  it falls back to the selected backend's defaults while disconnected, and
  `applyCapabilities` clamps `config` into range so no `<select>` goes blank),
  the capture↔monitor mutual-exclusion flag, and decode orchestration. A Run
  takes `config.captures` captures back to back, each an ordinary `CaptureBuffer`
  in the `captures` list — the pager just swaps `captureBuffer`, so the renderer,
  decoders, measurements and export need no notion of captures at all. Two rules
  hold that together. `captureStatus` stays `"running"` for the whole run, which
  is what lets the follow view and live in-view decode roll across capture
  boundaries. And a finished capture stays on screen until the next one's samples
  arrive: swapping the next (empty) buffer in at once happens in the same tick as
  the previous capture's `captureTick`, and `WaveformCanvas` reads
  `captureBuffer` when the coalesced frame runs — so the finished capture would
  be replaced before it was ever drawn, leaving every capture but the last
  invisible. It is marked with its trigger and decoded in place while small
  enough (`MAX_LANDED_DECODE_SAMPLES`), but never **refitted**, which would fight
  the rolling view; anything larger waits for the pager. `trimRetained` bounds
  the run by both samples and count — the count cap matters because the list is
  copied every capture. Hiding a channel also stops the decoders reading it —
  `decoderChannelsShown` is the shared predicate, used by both `runAllDecoders` and
  `WaveformCanvas`. `unloadGuard.ts` prompts on unload when a capture or serial log
  would be lost; imported/demo buffers deliberately don't prompt. `navigation.ts` owns
  zoom/pan and the live follow view; `fitRange` clamps to `[0, sampleCount]` so edge-
  or whole-spanning activity never frames negative time or trailing blank.
- `export/` — CSV/VCD chunk generators plus `stream.ts`, which assembles chunks while
  yielding to the event loop so a 100M-sample export doesn't freeze the tab or exceed
  V8's string limit. VCD embeds an exact `samplerate`/`samples` `$comment` and a
  trailing end-timestamp marker.
- `import/` — pure CSV/VCD parsers; `importFile` streams the file a slice at a time,
  never one giant string. VCD rate/length come from our `$comment`, else a
  GCD-of-timestamps fallback.
- `demo/` — `buildDemoCapture`: a synthetic no-hardware capture, one exchange per
  protocol across the 8 channels (channel map in its header). It is the single source
  of truth for both the `HelpMenu` demo action and the committed
  `demo/all-signals.vcd`.
- `test/` — shared doubles and fixtures: WebUSB fakes (`fakeUsb.ts`), Web Serial
  fakes (`fakeSerial.ts` — a `FakeSerialPort` scripted per opcode, which is how a
  SUMP exchange reads), a recording 2D context, waveform builders, and the jsdom
  setup.

## Conventions

- **TypeScript strict**; `noUnusedLocals`/`noUnusedParameters` are on.
- **Tests are required where meaningful, and land with the change** — not as a
  later pass. New pure logic, store orchestration, a reusable component, or a
  new interaction/behaviour (and any bug fix) should ship with its test in the
  same edit. Trivial/mechanical tweaks (copy, styling) don't need one.
- **Tests are colocated** as `*.test.ts`. Pure logic runs under Node; component
  tests opt into jsdom with a `// @vitest-environment jsdom` docblock at the top
  and use `@testing-library/svelte`. `render` early-returns without a 2D context,
  so component tests may set a `captureBuffer` and drive interactions safely.
- Keep decode logic pure and unit-tested; keep WebUSB/DOM specifics thin.
- **Hide what a backend can never do; annotate what it merely does differently.**
  A permanently dead control is worse than an absent one, so the Firmware chip,
  the Serial Monitor tab and the Follow toggle all disappear for a backend whose
  `DeviceCapabilities` rule them out. Capability that still works by another
  route stays put and is labelled instead — an edge trigger on a device whose
  trigger unit matches levels only is grouped under "found after capture", not
  removed.
- **Font sizes use the `--fs-*` tokens** in `app.css` (`--fs-title`/`--fs-body`/
  `--fs-ui`/`--fs-micro`), never hardcoded px. `--fs-ui` (12px) is the floor for
  DOM text; `--fs-micro` (10px) is only for canvas ruler ticks.
- **Slashes: tight for a name, spaced for a list.** `SUMP/OLS`, `min/max`,
  `import/export` — two items reading as one thing take no spaces; a run you scan
  item by item does (`UART / SPI / I²C / 1-Wire / CAN`), as does either side being
  a phrase (`Open Bench Logic Sniffer / Bus Pirate`).
- **Formatting** is owned by Prettier and **linting** by ESLint (flat config,
  recommended presets) — run `npm run format` / `npm run lint` before finishing.
  No new deps without reason.
- **`README.md` is for end users**, not contributors: describe what a feature does
  for the user and keep implementation detail (algorithms, data structures, module
  names) out of it — that belongs here in `AGENTS.md`. The one exception is the
  README's own short "Architecture" module map.

## Hardware/domain notes (important)

- **WebUSB and Web Serial are both Chromium-only** and need a secure context
  (localhost or HTTPS).
- **The capture path always streams all 8 channels** (1 byte/sample) — deselecting a
  channel only hides it from view/decode/export, never reducing the stream. This is
  because the app captures in fx2lafw's 8-bit mode (`encodeSampleRate` default
  `wide=false`); a 16-bit/`wide` path and a 16-channel firmware are bundled but the
  app doesn't drive them. It's a capture-mode fact, not a bug.
- **No hardware trigger on the FX2** — it streams continuously; triggering is done
  in software (`model/trigger.ts`), matching sigrok. SUMP devices with a trigger
  unit get the condition in hardware, but only when every condition is a level:
  a SUMP stage matches a level _pattern_, so an edge falls back to the software
  trigger (`triggerStages()` returns null and the driver arms a start-immediately
  stage instead).
- **Keep multiple bulk transfers in flight** during capture (`capture.ts`); a
  single-transfer loop stalls the FX2 FIFO after one buffer. Size the queue with
  the rate — `transferPlan()` follows libsigrok (≈10 ms per buffer, ≈500 ms of
  capture queued, ≤32 transfers) — because the queue _is_ the tolerance for a busy
  main thread: a fixed 8 × 64 KB is only 21 ms of slack at 24 MHz, so one slow
  frame ends the capture.
- **A dead stream never comes back, and a quiet endpoint never settles.** Once the
  host falls behind — the page blocked by a modal prompt (the `beforeunload`
  confirmation!), a suspended machine — the FIFO overflows and fx2lafw stops
  sending; a pending bulk IN read then hangs forever, so the capture loop needs the
  `stallTimeout` watchdog to end the run and keep the partial capture. Any change
  around that timeout must stay rate-aware: one 64 KB transfer at 20 kHz takes 3.3 s
  to fill, so a fixed sub-second bound would abort healthy slow captures.
- The bulk-IN endpoint is read from the descriptor at runtime (0x82 vs 0x86).
- **Keep per-chunk work O(chunk), never O(total).** `captureTick` bumps on every
  streamed chunk, so anything that rescans the whole buffer per chunk (rebuilding
  the full transition index, decoding/clustering the entire capture) is O(n²) over
  the run and, on a large capture, blocks the main thread long enough to overflow
  the FX2 FIFO and **stall the stream**. Live features must work on a bounded
  window (the on-screen range) or track incrementally as samples append — see the
  min/max pyramid and activity-cluster tally in `model/capture.ts`, and the
  windowed live decode in `stores/navigation.ts`.

### SUMP/OLS specifics

Sourced from the sump.org spec, the _Logic Sniffer Demon Core FPGA Specification_
rev 1.03, libsigrok's `openbench-logic-sniffer` driver, and the firmware of Bus
Pirate v3/v5, AGLA and ESP32-Bit-Pirate.

- **The dump arrives newest-sample-first.** `sump/device.ts` pre-allocates the whole
  buffer and fills it _backwards_, then hands it over in one `onData` — which also
  means an early stop leaves a contiguous newest-N run that is still a valid,
  correctly-ordered capture. Get this wrong and every waveform is time-reversed;
  it is the highest-risk defect in the driver and `device.test.ts` pins it.
- **There is no live view for SUMP.** The device fills its own memory first and
  only then uploads, so `capabilities.streaming` is false and the status line is
  the only progress there is. `stores/navigation.ts` gates the rolling view on
  `capabilities.streaming` as well as on `follow`, because that preference
  outlives a device change. `continuous` is false too — a property of the
  protocol, not of one device — and besides hiding the tab, `stores/monitor.ts`
  and the panel refuse defensively.
- **What a trigger is for on a one-shot device.** A level condition on a device
  with a trigger unit is exact: it sits armed and catches the real thing, and
  the driver reports it at sample 0 (`onTrigger`) instead of searching for it.
  The window opens at the trigger, not necessarily on it: an OLS-style core
  starts one sample later (libsigrok's `trigger_at = … − num_stages`), so a
  level that brief is gone from the data and a search would mark the next
  occurrence. Pre-trigger samples would bring it back, but would change the
  counts every compatible has been tested with. Every other case — any edge, and anything at all on a device without a trigger unit —
  is `findTrigger` searching what was already captured. That still earns its
  place: it sets the time origin (the ruler, the marker, and the measurement
  cursors all hang off it) and it is what ends an "until stopped" run. But
  hunting by re-arming is best-effort, since the device is blind while uploading.
- **Captures are events, not a timeline.** A device can't capture while it is
  uploading, so the gaps between repeat captures are large and unrecorded — at
  115200 baud a 4096-sample capture spends ~1% of its time sampling. That is why
  they are never appended into one buffer: the decoders would corrupt at every
  seam and every measurement across one would be wrong.
- **Read/delay counts are in units of 4 samples, minus one** (`readcount/4 − 1`).
  So 1..4 samples all encode as 0, and a request is rounded _down_ to a multiple of
  4 before clamping to the device's memory — rounding up would overshoot it.
- **Command payloads are little-endian; `0x04` metadata integers are big-endian.**
  The single most common implementation bug.
- **Flags bits 2–5 _disable_ channel groups**, so group-0-only is `0x38`. Sending
  `0x82` is mandatory, not an optimisation: a Bus Pirate 5 left with groups 2 and 3
  enabled pads every sample with a `0x55`/`0xAA` dummy pattern.
- **Never send a long opcode a device may not implement.** ESP32-Bit-Pirate ignores
  an unknown opcode _without consuming its 4 payload bytes_ and is then desynced for
  good — so `0x83`/`0x84` (32-bit counts) are gated on `profiles.ts`'s `wideCounts`,
  never probed. Everything else in a profile degrades gracefully.
- **Divider = clock / rate − 1**, and the clock is a hard ceiling (both the OLS and
  ESP32-BP advertise 200 MHz off a 100 MHz divider). Achievable rates are a
  continuum, not a table: `resolveSampleRate()` is what the `CaptureBuffer` rate
  must come from, or the time axis is wrong.
- **End of dump is a byte count, not a sentinel.** Count the expected bytes (clamped
  to the reported memory) as the primary condition, with an idle timeout as the
  fallback and a separate, rate-aware wait for the _first_ byte — an armed device
  sends nothing until its trigger fires, and even without one nothing arrives until
  its memory is full.
- **Send `0x00` five times** before anything and before each arm: a device may be
  part-way through a 5-byte long command, so one reset byte can be eaten as payload.
- **RLE stays off** (flags bit 8). sigrok documents its OLS support as broken and the
  compatibles disagree on whether the run length is inclusive.
- **Serial params are `115200/8N1` with `flowControl: "none"`** — never driver-level
  XON/XOFF, since `0x11`/`0x13` occur freely inside sample data.

## Adding a protocol decoder

Implement the `Decoder` interface in `decode/types.ts` and register it in
`decode/registry.ts`:

- **Logic decoder**: a generator that `yield`s wait conditions — use `cond(ch, code)`
  (e.g. `cond(0, 'f')`), `{ skip: n }`, or an OR-list — and calls `ctx.put(...)` for
  annotations / `ctx.emit(...)` for stackable `byte` packets. Advance to a computed
  sample with `yield* skipToSample(ctx, n)`, and format annotation text with `hex` /
  `isPrintable` from `decode/format.ts`. See `decoders/uart.ts` and `decoders/can.ts`
  (bit destuffing).
- **Stacked decoder**: set `meta.inputType` and implement
  `decodeStacked(packets, ctx)`. See `decoders/ascii.ts`.
- **Options** (`meta.options`): `values` renders a fixed `<select>`; `presets`
  renders an editable dropdown (pick a preset or type a custom value — e.g. UART
  `baudrate`); neither renders a plain text field.

## Firmware & licensing

The bundled firmware (`src/firmware/*.fw`) is **sigrok-firmware-fx2lafw 0.1.7,
GPLv2+** — a separate program uploaded to the device (mere aggregation), which
does not affect this project's own license. License texts, the source pointer,
and the written offer are in `third-party/`. Do not strip those notices.
