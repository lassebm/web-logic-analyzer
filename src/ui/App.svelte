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
    captureStatus,
    captureBuffer,
    captureTick,
    runDetection,
  } from "../stores/session";
  import {
    zoomToFit,
    jumpToContent,
    activityPosition,
  } from "../stores/navigation";

  // The `$captureTick >= 0` term (always true) makes this re-evaluate as samples
  // stream in and at finish — the buffer fills by mutation, not by re-setting.
  let hasCapture = $derived(
    $captureTick >= 0 && ($captureBuffer?.sampleCount ?? 0) > 0,
  );
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
    <button
      class:active={$activeTab === "monitor"}
      onclick={() => activeTab.set("monitor")}
    >
      Serial Monitor
      {#if $monitorActive}<span class="tab-dot" title="Running"></span>{/if}
    </button>
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
          <button
            disabled={!hasCapture}
            onclick={runDetection}
            title="Scan active channels for supported protocols and detect their settings"
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
    padding: 6px 14px;
    border-bottom: 1px solid var(--border);
    background: var(--bg-panel);
  }
  .sep {
    width: 1px;
    height: 20px;
    background: var(--border);
  }
  /* Activity region pager: a label, prev/next steppers, and a position readout. */
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
