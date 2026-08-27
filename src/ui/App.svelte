<script lang="ts">
  import DeviceBar from "./DeviceBar.svelte";
  import CaptureControls from "./CaptureControls.svelte";
  import WaveformCanvas from "./WaveformCanvas.svelte";
  import Measurements from "./Measurements.svelte";
  import DecoderPanel from "./DecoderPanel.svelte";
  import DetectPanel from "./DetectPanel.svelte";
  import ExportMenu from "./ExportMenu.svelte";
  import ImportMenu from "./ImportMenu.svelte";
  import SerialMonitor from "./SerialMonitor.svelte";
  import {
    activeTab,
    monitorActive,
    capabilities,
    capturePosition,
    stepCapture,
    captureStatus,
    captureBuffer,
    captureTick,
    detections,
    toggleDetection,
  } from "../stores/session";
  import {
    zoomToFit,
    jumpToContent,
    activityPosition,
  } from "../stores/navigation";
  import { registerUnloadGuard } from "../stores/unloadGuard";

  // Warn before a refresh/navigation would discard a capture or serial log.
  $effect(() => registerUnloadGuard());

  // The `$captureTick >= 0` term (always true) makes this re-evaluate as samples
  // stream in and at finish — the buffer fills by mutation, not by re-setting.
  let hasCapture = $derived(
    $captureTick >= 0 && ($captureBuffer?.sampleCount ?? 0) > 0,
  );

  // Switching to a backend that has no Serial Monitor hides its tab; sitting on
  // that tab would then show an empty page, so fall back to the analyzer.
  $effect(() => {
    if (!$capabilities.continuous && $activeTab === "monitor")
      activeTab.set("analyzer");
  });
</script>

<div class="app">
  <DeviceBar />

  <nav class="tabs">
    <button
      class:active={$activeTab === "analyzer"}
      onclick={() => activeTab.set("analyzer")}
    >
      Logic Analyzer
      {#if $captureStatus === "running"}<span class="tab-dot" title="Capturing"
        ></span>{/if}
    </button>
    <!-- The Serial Monitor needs an endless stream. A SUMP device fills its own
         memory and dumps it, so it can never provide one — that is a property of
         the protocol, not of one device, so the tab is hidden for the whole
         backend rather than shown permanently dead (the same reason the Firmware
         chip is FX2-only). stores/monitor.ts still refuses defensively. -->
    {#if $capabilities.continuous}
      <button
        class:active={$activeTab === "monitor"}
        onclick={() => activeTab.set("monitor")}
      >
        Serial Monitor
        {#if $monitorActive}<span class="tab-dot" title="Running"></span>{/if}
      </button>
    {/if}
  </nav>

  {#if $activeTab === "analyzer"}
    <CaptureControls />
    <div class="body">
      <main class="wave-area">
        <div class="toolbar">
          <button
            disabled={!hasCapture}
            onclick={zoomToFit}
            title="Zoom to fit the whole capture">Fit</button
          >
          <div
            class="activity"
            role="group"
            aria-label="Signal activity regions"
          >
            <span class="activity-label">Activity</span>
            <button
              class="step"
              disabled={!$activityPosition ||
                $captureStatus === "running" ||
                $activityPosition.index <= 0}
              onclick={() => jumpToContent(-1)}
              title="Previous region of signal activity (or back to the whole view)"
              aria-label="Previous activity region">◀</button
            >
            <span
              class="activity-count"
              title={!$activityPosition
                ? "No signal activity"
                : $activityPosition.index === 0
                  ? `No region selected — ${$activityPosition.total} found (▶ jumps to the first)`
                  : `Activity region ${$activityPosition.index} of ${$activityPosition.total}`}
            >
              {$activityPosition
                ? `${$activityPosition.index}/${$activityPosition.total}`
                : "–"}
            </span>
            <button
              class="step"
              disabled={!$activityPosition ||
                $captureStatus === "running" ||
                $activityPosition.index >= $activityPosition.total}
              onclick={() => jumpToContent(1)}
              title="Next region of signal activity"
              aria-label="Next activity region">▶</button
            >
          </div>
          {#if $capturePosition}
            <div class="activity" role="group" aria-label="Captures">
              <span class="activity-label">Capture</span>
              <button
                class="step"
                disabled={$captureStatus === "running" ||
                  $capturePosition.index <= 1}
                onclick={() => stepCapture(-1)}
                title="Previous capture from this run"
                aria-label="Previous capture">◀</button
              >
              <span class="counted">
                <span
                  class="activity-count"
                  title={`Capture ${$capturePosition.index} of ${$capturePosition.total}${
                    $capturePosition.triggered > 0
                      ? ` — ${$capturePosition.triggered} met the trigger${$capturePosition.currentTriggered ? ", including this one" : ""}`
                      : ""
                  } — each is a separate recording; the time between them is not captured`}
                >
                  {$capturePosition.index}/{$capturePosition.total}
                </span>
                <span
                  class="trig"
                  class:on={$capturePosition.currentTriggered}
                  title="This capture met the trigger condition"
                ></span>
              </span>
              <button
                class="step"
                disabled={$captureStatus === "running" ||
                  $capturePosition.index >= $capturePosition.total}
                onclick={() => stepCapture(1)}
                title="Next capture from this run"
                aria-label="Next capture">▶</button
              >
            </div>
          {/if}
          <button
            class:active={$detections !== null}
            disabled={!hasCapture}
            onclick={toggleDetection}
            aria-expanded={$detections !== null}
            title={$detections !== null
              ? "Hide detection results"
              : "Scan active channels for supported protocols and detect their settings"}
            >Detect</button
          >
          <span class="sep"></span>
          <ImportMenu />
          <ExportMenu />
        </div>
        <DetectPanel />
        <div class="wave-scroll">
          <WaveformCanvas />
        </div>
        <Measurements />
      </main>
      <aside class="side">
        <DecoderPanel />
      </aside>
    </div>
  {:else}
    <div class="body">
      <SerialMonitor />
    </div>
  {/if}
</div>

<style>
  .app {
    display: flex;
    flex-direction: column;
    height: 100vh;
  }
  .tabs {
    display: flex;
    gap: 2px;
    padding: 0 10px;
    background: var(--bg-panel);
    border-bottom: 1px solid var(--border);
  }
  .tabs button {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    background: none;
    border: none;
    border-bottom: 2px solid transparent;
    border-radius: 0;
    padding: 9px 14px;
    color: var(--fg-dim);
  }
  .tab-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--accent);
  }
  .tabs button:hover {
    color: var(--fg);
  }
  .tabs button.active {
    color: var(--accent);
    border-bottom-color: var(--accent);
  }
  .body {
    flex: 1;
    display: flex;
    min-height: 0;
  }
  .wave-area {
    flex: 1;
    display: flex;
    flex-direction: column;
    min-width: 0;
  }
  .toolbar {
    display: flex;
    align-items: center;
    gap: 10px;
    /* Height from --bar-h, not padding, so it matches the decoder panel's
       header across the divider. */
    min-height: var(--bar-h);
    padding: 0 14px;
    border-bottom: 1px solid var(--border);
    background: var(--bg-panel);
  }
  /* Pressed look while the pane the button opened is showing. */
  .toolbar button.active {
    border-color: var(--accent);
    color: var(--accent);
  }
  .sep {
    width: 1px;
    height: 20px;
    background: var(--border);
  }
  .activity {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .activity-label {
    color: var(--fg-dim);
    font-size: var(--fs-ui);
  }
  .step {
    padding: 5px 9px;
    line-height: 1;
  }
  /* The marker annotates the readout rather than standing beside it, so the two
     are grouped and sit closer together than .activity's 6px gap. */
  .counted {
    display: inline-flex;
    align-items: center;
    gap: 2px;
  }
  /* Outside .activity-count so it can't shove the centred digits sideways, and
     it keeps its space when there is nothing to mark, so paging across a
     triggered capture doesn't shift the readout (cf. .counter-field in
     CaptureControls, reserved for the same reason).
     Drawn rather than typed: a bullet or asterisk glyph is small and sits at a
     different height in every font, so its size and vertical centring can't be
     relied on. Same dot as .tab-dot above, which marks a running capture. */
  .trig {
    width: 6px;
    height: 6px;
    flex: none;
    border-radius: 50%;
    background: var(--accent);
    visibility: hidden;
  }
  .trig.on {
    visibility: visible;
  }
  .activity-count {
    min-width: 34px;
    text-align: center;
    font-family: var(--mono);
    font-size: var(--fs-ui);
    color: var(--fg-dim);
    font-variant-numeric: tabular-nums;
  }
  .wave-scroll {
    flex: 1;
    min-height: 0;
  }
  .side {
    width: 300px;
    flex: none;
    border-left: 1px solid var(--border);
    background: var(--bg-panel);
    overflow: hidden;
  }
</style>
