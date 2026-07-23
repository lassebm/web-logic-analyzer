<script lang="ts">
  import { onMount } from "svelte";
  import {
    captureBuffer,
    captureTick,
    view,
    cursors,
    triggerSample,
    decoders,
    decodersEnabled,
    config,
    viewportWidth,
    viewFitsWhole,
  } from "../stores/session";
  import { getDecoder } from "../decode/registry";
  import {
    render as renderWaveform,
    xToSample,
    type RenderRow,
  } from "../view/renderer";
  import { CHANNEL_NAMES } from "../usb/constants";

  const ROW_HEIGHT = 40;
  const RULER_HEIGHT = 22;
  const GUTTER = 140;

  let canvas: HTMLCanvasElement | undefined = $state();
  let wrap: HTMLDivElement | undefined = $state();
  let width = $state(800);

  // Build the ordered list of rows (channels first, then decoder lanes). Disabled
  // decoders (master off, or their own toggle off) drop out so you can focus on
  // a subset.
  let rows = $derived(
    buildRows($config.enabledChannels, $decoders, $decodersEnabled),
  );
  let labels = $derived(
    rows.map((r) =>
      r.kind === "channel" ? CHANNEL_NAMES[r.channel] : r.label,
    ),
  );
  let totalHeight = $derived(
    RULER_HEIGHT + Math.max(rows.length * ROW_HEIGHT, ROW_HEIGHT),
  );

  function buildRows(
    enabled: boolean[],
    decs: typeof $decoders,
    decodersOn: boolean,
  ): RenderRow[] {
    const out: RenderRow[] = [];
    enabled.forEach((on, ch) => {
      if (on)
        out.push({ kind: "channel", channel: ch, label: CHANNEL_NAMES[ch] });
    });
    decs.forEach((inst, di) => {
      const dec = getDecoder(inst.decoderId);
      if (!dec) return;
      if (!decodersOn || inst.enabled === false) return; // disabled -> no lanes
      dec.meta.annotationRows.forEach((ar, ri) => {
        const anns = inst.annotations.filter((a) =>
          ar.classes.includes(a.annClass),
        );
        out.push({
          kind: "annotation",
          label: `${inst.label}:${ar.name}`,
          annotations: anns,
          hue: (di * 67 + ri * 23) % 360,
        });
      });
    });
    return out;
  }

  function draw() {
    const buf = $captureBuffer;
    if (!canvas || !buf) return;
    renderWaveform(canvas, {
      buf,
      view: $view,
      rows,
      rowHeight: ROW_HEIGHT,
      width,
      height: totalHeight,
      rulerHeight: RULER_HEIGHT,
      originSample: $triggerSample ?? 0,
      triggerSample: $triggerSample,
      cursors: $cursors,
      dpr: window.devicePixelRatio || 1,
    });
  }

  // Coalesce redraws to at most one per animation frame. During capture,
  // captureTick and (with Follow on) view can each update many times per frame;
  // scheduling a fresh draw for every change would run several full redraws in
  // the same frame. A single pending rAF collapses them into one.
  let frame = 0;
  function schedule() {
    if (frame || !canvas) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      draw();
    });
  }

  // Redraw whenever inputs change. draw() reads these inside rAF (async), which
  // wouldn't register as $effect dependencies, so touch them synchronously here.
  $effect(() => {
    void [
      $captureTick,
      $view,
      rows,
      $cursors,
      $triggerSample,
      width,
      totalHeight,
    ];
    schedule();
  });

  onMount(() => {
    // Measure the canvas's own container, not the whole .wave flex row — the
    // latter includes the fixed label gutter, which would size the canvas ~140px
    // too wide and cause a phantom horizontal scroll.
    const ro = new ResizeObserver((entries) => {
      width = Math.max(100, entries[0].contentRect.width);
      viewportWidth.set(width);
    });
    ro.observe(wrap!);
    return () => {
      ro.disconnect();
      if (frame) cancelAnimationFrame(frame);
    };
  });

  // --- Interaction ---
  // Ctrl/⌘ + wheel zooms at the cursor; Shift + wheel and a horizontal (two-finger)
  // trackpad swipe both pan horizontally; a plain vertical wheel is left to scroll
  // the view natively (so the decoder lanes below the channels stay reachable when
  // the content is taller than the viewport).
  function onWheel(e: WheelEvent) {
    if (!$captureBuffer) return;

    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      viewFitsWhole.set(false); // manual zoom leaves fit mode (no re-fit on resize)
      const rect = canvas!.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const anchor = xToSample(mx, $view);
      const factor = e.deltaY > 0 ? 1.2 : 1 / 1.2;
      const newSpp = Math.min(
        Math.max($view.samplesPerPixel * factor, 1 / 64),
        1e7,
      );
      view.set({ samplesPerPixel: newSpp, viewStart: anchor - mx * newSpp });
    } else if (e.shiftKey) {
      // Shift+wheel; some platforms report the delta on deltaX instead of deltaY.
      e.preventDefault();
      viewFitsWhole.set(false); // manual pan leaves fit mode
      const d = e.deltaY || e.deltaX;
      view.update((v) => ({
        ...v,
        viewStart: v.viewStart + d * v.samplesPerPixel,
      }));
    } else if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
      // Horizontal trackpad swipe → pan, no modifier needed.
      e.preventDefault();
      viewFitsWhole.set(false); // manual pan leaves fit mode
      view.update((v) => ({
        ...v,
        viewStart: v.viewStart + e.deltaX * v.samplesPerPixel,
      }));
    }
    // plain vertical wheel: do nothing here -> the .wave container scrolls natively
  }

  let dragging = $state(false);
  let dragStartX = $state(0);
  let dragStartView = $state(0);
  let moved = $state(false);

  function onPointerDown(e: PointerEvent) {
    if (!$captureBuffer) return;
    dragging = true;
    moved = false;
    dragStartX = e.clientX;
    dragStartView = $view.viewStart;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  }
  function onPointerMove(e: PointerEvent) {
    if (!dragging) return;
    const dx = e.clientX - dragStartX;
    if (Math.abs(dx) > 3) moved = true;
    if (moved) viewFitsWhole.set(false); // drag-pan leaves fit mode
    view.update((v) => ({
      ...v,
      viewStart: dragStartView - dx * v.samplesPerPixel,
    }));
  }
  function onPointerUp(e: PointerEvent) {
    if (!dragging) return;
    dragging = false;
    if (!moved) placeCursor(e);
  }

  let nextCursor = $state(0);
  function placeCursor(e: PointerEvent) {
    const rect = canvas!.getBoundingClientRect();
    const sample = Math.round(xToSample(e.clientX - rect.left, $view));
    cursors.update((c) => {
      const next = [...c];
      if (next.length < 2) {
        next.push(sample);
      } else {
        next[nextCursor] = sample;
        nextCursor = (nextCursor + 1) % 2;
      }
      return next;
    });
  }
</script>

<div class="wave">
  <div class="gutter" style="width:{GUTTER}px">
    <div class="ruler-label" style="height:{RULER_HEIGHT}px">
      Time{$triggerSample !== null ? " (from trigger)" : ""}
    </div>
    {#each labels as label, i (i)}
      <div
        class="label mono"
        class:ann={rows[i].kind === "annotation"}
        style="height:{ROW_HEIGHT}px"
      >
        {label}
      </div>
    {/each}
  </div>
  <div class="canvas-wrap" bind:this={wrap} style="height:{totalHeight}px">
    {#if !$captureBuffer}
      <div class="empty">No capture yet. Connect a device and click Run.</div>
    {/if}
    <canvas
      bind:this={canvas}
      title="Drag or swipe horizontally to pan · Ctrl/⌘+scroll to zoom · Shift+scroll to pan · scroll to move vertically · click to drop cursors"
      onwheel={onWheel}
      onpointerdown={onPointerDown}
      onpointermove={onPointerMove}
      onpointerup={onPointerUp}
    ></canvas>
  </div>
</div>

<style>
  .wave {
    display: flex;
    /* Vertical scroll for tall lane stacks; the canvas is sized to fit exactly,
       so there should be no horizontal scroll (guard against subpixel rounding). */
    overflow-x: hidden;
    overflow-y: auto;
    overscroll-behavior: contain;
    height: 100%;
  }
  .gutter {
    flex: none;
    border-right: 1px solid var(--border);
    background: var(--bg-panel);
    position: sticky;
    left: 0;
    z-index: 1;
  }
  .ruler-label {
    display: flex;
    align-items: center;
    padding: 0 10px;
    font-size: var(--fs-micro);
    color: var(--fg-dim);
    border-bottom: 1px solid var(--border);
    background: var(--bg-ruler);
  }
  .label {
    display: flex;
    align-items: center;
    padding: 0 10px;
    font-size: var(--fs-ui);
    color: var(--fg);
    border-bottom: 1px solid var(--border);
  }
  .label.ann {
    color: var(--fg-dim);
    font-size: var(--fs-ui);
  }
  .canvas-wrap {
    position: relative;
    flex: 1;
    min-width: 0;
  }
  canvas {
    display: block;
    cursor: crosshair;
  }
  /* Pin the placeholder near the top: `.canvas-wrap` is only `totalHeight` tall, so
     centering drifts down as more channel lanes are enabled. Top-align keeps it put. */
  .empty {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: flex-start;
    justify-content: center;
    padding-top: 30px;
    color: var(--fg-dim);
  }
</style>
