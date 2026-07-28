# AGENTS.md

Guidance for AI agents and contributors working in this repository.

## Project

**Web Logic Analyzer** — a browser-based logic analyzer that drives FX2LP
(`fx2lafw`) devices directly over **WebUSB**: uploads firmware, captures the 8
digital channels, visualizes them, and decodes protocols. No native install.

Stack: **Svelte 5 (runes: `$state`/`$derived`/`$props`) + Vite + TypeScript**.
Waveform rendered on `<canvas>`.

## Commands

Scripts are in `package.json`. Two things it doesn't tell you:

- `npm run dev` serves on `http://127.0.0.1:5173` — localhost is a secure context, so
  WebUSB works there.
- Before finishing any change: `npm run check`, `npm test`, and `npm run lint` must
  pass; formatting must be clean (`npm run format:check`); and `npm run build` should
  succeed.

## Architecture (`src/`)

Module map — one line per directory, with the couplings and invariants the code
alone won't teach you. Read the files for the actual APIs.

- `usb/` — WebUSB layer: device wrapper, firmware detect/upload/re-enumerate, a
  custom-firmware IndexedDB cache, the bulk-streaming capture loop, and the rate ↔ FX2
  clock-divider math plus the USB-bandwidth guard. The capture loop's transfer queue
  and stall watchdog are load-bearing — see the hardware notes below.
- `firmware/` — bundled `.fw` binaries and their loader. The loader maps filename →
  asset URL and nothing more: the VID:PID → firmware-filename map lives in
  `usb/constants.ts` (`PRE_FIRMWARE_DEVICES`), and the auto-select happens in
  `stores/session.ts` `provision()`.
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
- `stores/` — `session.ts` owns the device, the capture↔monitor mutual-exclusion flag,
  and decode orchestration. Hiding a channel also stops the decoders reading it —
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
- `test/` — shared doubles and fixtures: WebUSB fakes, a recording 2D context,
  waveform builders, and the jsdom setup.

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
