# AGENTS.md

Guidance for AI agents and contributors working in this repository.

## Project

**Web Logic Analyzer** — a browser-based logic analyzer that drives FX2LP
(`fx2lafw`) devices directly over **WebUSB**: uploads firmware, captures the 8
digital channels, visualizes them, and decodes protocols. No native install.

Stack: **Svelte 5 (runes: `$state`/`$derived`/`$props`) + Vite + TypeScript**.
Waveform rendered on `<canvas>`.

## Commands

```bash
npm install          # install deps
npm run dev          # dev server at http://127.0.0.1:5173 (localhost = secure context, WebUSB works)
npm run check        # svelte-check type check — must be 0 errors / 0 warnings
npm test             # vitest run (unit + component tests)
npm run test:coverage# vitest with v8 coverage report
npm run build        # svelte-check + production build to dist/
npm run lint         # eslint (typescript-eslint + eslint-plugin-svelte, flat config)
npm run lint:fix     # eslint --fix
npm run format       # prettier --write . (opinionated defaults, minimal config)
npm run format:check # prettier --check . (CI-friendly, no writes)
```

Before finishing any change: `npm run check`, `npm test`, and `npm run lint` must
pass; formatting must be clean (`npm run format:check`); and `npm run build` should
succeed.

## Architecture (`src/`)

- `usb/` — WebUSB layer: `constants.ts` (protocol facts), `fx2Device.ts` (device
  wrapper), `firmware.ts` (detect + upload + re-enumerate), `firmwareStore.ts`
  (custom-firmware IndexedDB cache), `capture.ts` (bulk streaming with an
  in-flight transfer queue, plus the pre-capture firmware-version/rev-id probe),
  `sampleRate.ts` (rate ↔ FX2 clock-divider `encodeSampleRate`, the supported-rate
  table `SAMPLE_RATES` (20 kHz–24 MHz), `formatSampleRate`, and the USB-bandwidth
  guard `bandwidthWarning` / `SUSTAINED_USB_BYTES_PER_SEC` (30 MB/s)).
- `firmware/` — bundled `.fw` binaries + loader (`index.ts`: `loadBundledFirmware` /
  `hasBundledFirmware` / `bundledFirmwareNames` — filename → asset URL only). The
  VID:PID → firmware-filename map lives in `usb/constants.ts` (`PRE_FIRMWARE_DEVICES`);
  the actual auto-select happens in `session.ts` `provision()`.
- `model/` — `capture.ts` (`CaptureBuffer`: packed samples, transition index,
  trimming; an incremental packed AND/OR **min/max pyramid** so `channelMinMax` is
  O(log n) for zoomed-out rendering; and a recent-edge ring + live activity-cluster
  tally — `recentEdgeInterval`/`activityClusterCount`/`latestCluster` — for the live
  follow view), `trigger.ts` (software trigger), `clusters.ts` (activity grouping).
- `decode/` — decoder plugin API (`types.ts`), `engine.ts` (edge-jumping generator
  runner — decoders `yield` wait conditions, the runner advances to the next match
  and calls back via `ctx.put`/`ctx.emit`/`ctx.pin` — plus stacked decoders;
  `cond()`/`skipToSample()` helpers;
  `runDecoder` takes an optional sample `range` to decode just a window, used for
  live in-view decoding),
  `format.ts` (shared `hex`/`isPrintable`), `decoders/` (uart, spi, i2c,
  onewire, can, ascii), `registry.ts`, `detect/` (protocol auto-detection:
  `uart.ts` — edge-timing baud estimate + trial-decode scoring; `i2c.ts` — scores
  a channel pair on two structural metrics (SDA steady while SCL is high, plus the
  fraction of SDA edges that land while SCL is high — near-zero on a real bus) and
  a trial decode requiring START+STOP+bytes — `detectI2c` takes a _fixed_ SCL/SDA
  orientation; `types.ts` — the `Detection` union + `detectionToDecoder`; `index.ts` —
  `detectI2cPair` tries both orientations and keeps the higher-confidence one, and
  `scanChannels` scores all I²C pairs and claims strongest-first (so a weak false
  pair can't steal a real bus's line) before single-channel UART runs on what's
  left).
- `view/` — `renderer.ts` (canvas: traces, ruler, annotation lanes).
- `ui/` — Svelte components (`App`, `DeviceBar`, `CaptureControls` (rate/samples/
  trigger + the **Follow** live-view toggle + the Captured/Loaded readout — percent
  of the sample limit during a real capture, a plain total for an imported/demo
  buffer, branched on a `sampleSource`-derived `loaded` flag), `WaveformCanvas` (redraws coalesced to
  one per animation frame; disabled decoders drop their lanes; manual zoom/pan
  clears `viewFitsWhole`), `Measurements`,
  `DecoderPanel` (add/configure decoders + master and per-decoder enable toggles +
  drag-handle reorder via `moveDecoder`),
  `DetectPanel` (auto-detect results), `ExportMenu`/`ImportMenu` (both show a busy
  progress % while streaming), `SerialMonitor`, `HelpMenu` (top-bar **?** popover
  with "Load demo capture")), plus the shared `InfoTip` (ⓘ
  hover/focus popover), `EditableSelect` (a native-`<select>` preset dropdown with a
  "Custom…" text-entry escape hatch — used for the serial-monitor baud rate and any
  decoder option that declares `presets`), and `format.ts`
  (`formatSampleCount` — compact k/M/G sample counts for the controls).
- `monitor/` — `terminal.ts` (serial-monitor line assembly, pure/testable).
- `stores/` — `session.ts` (stores + connect/capture/decode orchestration; owns the
  device and the capture↔monitor mutual-exclusion flag; `detections`/`runDetection`;
  decoder enable/disable — `decodersEnabled` master + per-instance `enabled`,
  `setDecoderEnabled`/`setAllDecodersEnabled` — and decoder reorder `moveDecoder`;
  `runAllDecoders(range?)`; `sampleSource` (capture vs import vs demo) and
  `viewFitsWhole` (the on-screen view is a whole-capture fit); `watchUsbDisconnect` —
  resets state when the device is unplugged; `loadCapture` — swaps in an imported
  buffer like a finished capture; `loadDemo` — loads the built-in demo capture and
  adds a decoder per protocol plus a stacked ASCII decoder),
  `monitor.ts` (serial-monitor orchestration), `navigation.ts` (waveform zoom/pan;
  at capture start, Follow-off pre-sizes the view to the sample limit
  (`resetViewForCapture`) while Follow-on rolls to frame the latest activity
  (`followView`), which also drives the throttled live in-view decode — plus the
  `activityCursor`/`activityPosition` readout;
  `fitRange` pads a region but clamps it to `[0, sampleCount]` so edge/whole-spanning
  activity never frames negative time or trailing blank; `viewFitsWhole` re-fits the
  whole view when the viewport width changes — window resize, or the demo fitting
  before its tab's canvas has laid out — and, on any whole-capture fit, resets
  `activityCursor` to 0).
- `export/` — `csv.ts`/`vcd.ts` (chunk generators + full-string `toCsv`/`toVcd`),
  `stream.ts` (`downloadChunks`: assembles chunks into a `Blob`, yielding to the event
  loop with progress so 100M-sample exports don't freeze the tab or exceed V8's string
  limit), `download.ts` (`downloadBlob`/`downloadText`). VCD embeds an exact
  `samplerate`/`samples` `$comment` and a trailing end-timestamp marker.
- `import/` — `parse.ts` (pure CSV/VCD parsers + shared line helpers and the
  `VcdAccumulator`; VCD rate/length come from our `$comment`, else a GCD-of-timestamps
  fallback), `importer.ts` (`importFile`: streams the file a slice at a time — never one
  giant string — parsing into a `CaptureBuffer` with progress).
- `demo/` — `capture.ts` (`buildDemoCapture`: a synthetic no-hardware capture with
  one exchange per protocol laid out sequentially across the 8 channels — see the
  channel map in its header; single source of truth for the `HelpMenu` demo action
  and the committed `demo/all-signals.vcd`. `DEMO_DECODERS` is the pre-wired decoder
  list `loadDemo` adds: one per protocol plus a stacked ASCII decoder after the UART).
- `test/` — shared test doubles/fixtures: `fakeUsb.ts` (WebUSB + `navigator.usb`
  fakes), `fakeCanvas.ts` (recording 2D context), `waveforms.ts` (sample/UART/I2C
  builders), `fixtures.ts` (`defaultConfig`), `setup.ts` (jsdom test setup:
  `@testing-library/jest-dom` matchers + a `ResizeObserver` polyfill).

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
- **Font sizes use the `--fs-*` tokens** in `app.css` (`--fs-title`/`--fs-body`/
  `--fs-ui`/`--fs-micro`), never hardcoded px. `--fs-ui` (12px) is the floor for
  DOM text; `--fs-micro` (10px) is only for canvas ruler ticks.
- **Formatting** is owned by Prettier and **linting** by ESLint (flat config,
  recommended presets) — run `npm run format` / `npm run lint` before finishing.
  No new deps without reason.
- **`README.md` is for end users**, not contributors: describe what a feature does
  for the user and keep implementation detail (algorithms, data structures, module
  names) out of it — that belongs here in `AGENTS.md`. The one exception is the
  README's own short "Architecture" module map.

## Hardware/domain notes (important)

- **WebUSB is Chromium-only** and needs a secure context (localhost or HTTPS).
- **The capture path always streams all 8 channels** (1 byte/sample) — deselecting a
  channel only hides it from view/decode/export, never reducing the stream. This is
  because the app captures in fx2lafw's 8-bit mode (`encodeSampleRate` default
  `wide=false`); a 16-bit/`wide` path and a 16-channel firmware are bundled but the
  app doesn't drive them. It's a capture-mode fact, not a bug.
- **No hardware trigger** — the FX2 streams continuously; triggering is done in
  software (`model/trigger.ts`), matching sigrok.
- **Keep multiple bulk transfers in flight** during capture (`capture.ts`); a
  single-transfer loop stalls the FX2 FIFO after one buffer (~65536 samples).
- The bulk-IN endpoint is read from the descriptor at runtime (0x82 vs 0x86).
- **Keep per-chunk work O(chunk), never O(total).** `captureTick` bumps on every
  streamed chunk, so anything that rescans the whole buffer per chunk (rebuilding
  the full transition index, decoding/clustering the entire capture) is O(n²) over
  the run and, on a large capture, blocks the main thread long enough to overflow
  the FX2 FIFO and **stall the stream**. Live features must work on a bounded
  window (the on-screen range) or track incrementally as samples append — see the
  min/max pyramid and activity-cluster tally in `model/capture.ts`, and the
  windowed live decode in `stores/navigation.ts`.

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
