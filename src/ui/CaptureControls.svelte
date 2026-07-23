<script lang="ts">
  import {
    config,
    connStatus,
    captureStatus,
    captureSamples,
    sampleSource,
    monitorActive,
    startCapture,
    stopCapture,
    decoderRateWarning,
  } from "../stores/session";
  import {
    SAMPLE_RATES,
    formatSampleRate,
    bandwidthWarning,
  } from "../usb/sampleRate";
  import { formatTime } from "../view/renderer";
  import { formatSampleCount } from "./format";
  import { CHANNEL_NAMES, NUM_CHANNELS } from "../usb/constants";
  import type { TriggerEdge } from "../model/trigger";
  import { follow } from "../stores/navigation";
  import InfoTip from "./InfoTip.svelte";

  const EDGES: { value: TriggerEdge | "off"; label: string }[] = [
    { value: "off", label: "None" },
    { value: "rising", label: "Rising ↑" },
    { value: "falling", label: "Falling ↓" },
    { value: "high", label: "High" },
    { value: "low", label: "Low" },
    { value: "any", label: "Either ↕" },
  ];

  // Per-channel trigger selection derived from the spec.
  function edgeFor(ch: number): TriggerEdge | "off" {
    const c = $config.trigger.conditions.find((x) => x.channel === ch);
    return c ? c.edge : "off";
  }

  function setEdge(ch: number, edge: string) {
    config.update((cfg) => {
      const conditions = cfg.trigger.conditions.filter((x) => x.channel !== ch);
      if (edge !== "off")
        conditions.push({ channel: ch, edge: edge as TriggerEdge });
      return { ...cfg, trigger: { conditions } };
    });
  }

  function toggleChannel(ch: number) {
    config.update((cfg) => {
      const enabledChannels = [...cfg.enabledChannels];
      enabledChannels[ch] = !enabledChannels[ch];
      return { ...cfg, enabledChannels };
    });
  }

  // Show/hide every channel at once. "None" then picking a couple is quicker than
  // deselecting six when you only care about one or two. (This is a view/decode/
  // export filter — fx2lafw always captures all 8, so it never disables capture.)
  function setAllChannels(on: boolean) {
    config.update((cfg) => ({
      ...cfg,
      enabledChannels: Array(NUM_CHANNELS).fill(on),
    }));
  }

  function clearTriggers() {
    config.update((cfg) => ({ ...cfg, trigger: { conditions: [] } }));
  }

  let warning = $derived(bandwidthWarning($config.sampleRate));
  let durationSec = $derived($config.sampleLimit / $config.sampleRate);

  let running = $derived($captureStatus === "running");
  // A loaded buffer (import/demo) wasn't captured against this session's sample
  // limit, so the "/ limit" denominator and the progress percentage are
  // meaningless for it — show only its total sample count.
  let loaded = $derived($sampleSource !== "capture");
  // Fraction of the requested sample count collected so far (0..100). `collected`
  // is clamped to sampleLimit upstream, so this never overshoots 100%.
  let capturePct = $derived(
    $config.sampleLimit > 0
      ? Math.min(100, Math.round(($captureSamples / $config.sampleLimit) * 100))
      : 0,
  );
  let canRun = $derived($connStatus === "ready" && !running && !$monitorActive);
  let runHint = $derived.by(() => {
    if ($monitorActive)
      return "Serial Monitor is running — stop it first (Serial Monitor tab).";
    if ($connStatus !== "ready") return "Connect a device first.";
    return "";
  });
</script>

<section class="controls">
  <div class="field">
    <label for="rate">Sample rate</label>
    <select id="rate" bind:value={$config.sampleRate}>
      {#each SAMPLE_RATES as r (r)}
        <option value={r}>{formatSampleRate(r)}</option>
      {/each}
    </select>
  </div>

  <div class="field">
    <label for="limit">Samples</label>
    <select id="limit" bind:value={$config.sampleLimit}>
      {#each [10000, 100000, 1000000, 5000000, 10000000, 50000000, 100000000] as n (n)}
        <option value={n}>{formatSampleCount(n)}</option>
      {/each}
    </select>
  </div>

  <div class="field">
    <span class="flabel">Duration</span>
    <span
      class="cval"
      title="Time to capture the full sample count at this rate (if not stopped early)"
    >
      ≈ {formatTime(durationSec)}
    </span>
  </div>

  <div class="field">
    <span class="flabel">
      Live view
      <InfoTip label="How the live view works" width={250}>
        While capturing, keep the newest samples in view, auto-zooming to the
        signal's activity so it stays readable as it streams. Turn off to keep a
        fixed view of the whole capture that fills in from the left. Either way,
        the whole capture is fitted to the view when the run ends.
      </InfoTip>
    </span>
    <label
      class="toggle"
      title="Keep the newest samples in view while capturing (roll)"
    >
      <input type="checkbox" bind:checked={$follow} />
      <span>Follow</span>
    </label>
  </div>

  <div class="divider" aria-hidden="true"></div>

  <div class="field chan-field">
    <div class="chan-grid">
      <div class="crow">
        <span class="rowlabel">Channels</span>
        {#each Array(NUM_CHANNELS) as _, ch (ch)}
          <button
            class="cell chip"
            class:on={$config.enabledChannels[ch]}
            onclick={() => toggleChannel(ch)}>{CHANNEL_NAMES[ch]}</button
          >
        {/each}
        <span class="quick">
          <button
            class="qbtn"
            onclick={() => setAllChannels(true)}
            title="Show all channels">All</button
          >
          <span class="qsep" aria-hidden="true">·</span>
          <button
            class="qbtn"
            onclick={() => setAllChannels(false)}
            title="Hide all channels (then pick the ones you want)">None</button
          >
        </span>
      </div>
      <div class="crow">
        <span class="rowlabel">
          Trigger
          <InfoTip label="How the trigger works" width={260}>
            One trigger for the whole capture: it fires at the first sample
            where
            <strong>all</strong> the per-channel conditions are met at once
            (AND). Leave every channel on <span class="mono">None</span> to start
            at the beginning of the capture.
          </InfoTip>
        </span>
        {#each Array(NUM_CHANNELS) as _, ch (ch)}
          <select
            class="cell edge"
            value={edgeFor(ch)}
            onchange={(e) => setEdge(ch, e.currentTarget.value)}
            title="Software trigger condition for {CHANNEL_NAMES[ch]}"
          >
            {#each EDGES as ed (ed.value)}
              <option value={ed.value}>{ed.label}</option>
            {/each}
          </select>
        {/each}
        {#if $config.trigger.conditions.length > 0}
          <span class="quick">
            <button
              class="qbtn"
              onclick={clearTriggers}
              title="Clear all trigger conditions">Clear</button
            >
          </span>
        {/if}
      </div>
    </div>
  </div>

  <div class="field counter-field">
    <span class="flabel">{loaded ? "Loaded" : "Captured"}</span>
    <span class="cval">
      {#if loaded}
        {$captureSamples.toLocaleString()} samples
      {:else}
        {$captureSamples.toLocaleString()} / {formatSampleCount(
          $config.sampleLimit,
        )}
        samples
        {#if $captureSamples > 0}
          <span class="pct">({capturePct}%)</span>
        {/if}
      {/if}
    </span>
  </div>

  <div class="field">
    <span class="flabel">&nbsp;</span>
    {#if running}
      <button class="danger" onclick={stopCapture}>Stop</button>
    {:else}
      <button
        class="primary"
        onclick={startCapture}
        disabled={!canRun}
        title={runHint}>Run</button
      >
    {/if}
  </div>
</section>

{#if warning}
  <div class="warn">⚠ {warning}</div>
{/if}
{#if $decoderRateWarning}
  <div class="warn">⚠ {$decoderRateWarning}</div>
{/if}

<style>
  /* One cohesive toolbar; items wrap and align on their bottoms. */
  .controls {
    display: flex;
    align-items: flex-end;
    gap: 14px 16px;
    padding: 10px 14px;
    background: var(--bg-panel);
    border-bottom: 1px solid var(--border);
    flex-wrap: wrap;
  }
  .field {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  /* Push the capture status to the right on wide layouts; reserve width so the
     Run button doesn't jump as the digit count changes. */
  .counter-field {
    margin-left: auto;
    min-width: 260px;
  }
  /* Uniform label + control heights so everything lines up across the row. */
  .field label,
  .flabel {
    font-size: var(--fs-ui);
    line-height: 16px;
    color: var(--fg-dim);
  }
  /* Let a label carry an inline InfoTip without knocking the ⓘ off the baseline. */
  .flabel {
    display: inline-flex;
    align-items: center;
    gap: 3px;
  }
  .field select,
  .field button,
  .field .cval {
    height: 30px;
    box-sizing: border-box;
  }
  /* Derived/live readouts (not inputs): plain mono values, no input chrome. */
  .cval {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font-family: var(--mono);
    font-size: var(--fs-ui);
    color: var(--fg);
    white-space: nowrap;
  }
  /* Percent-of-target readout, dimmed so the raw sample counts stay primary. */
  .pct {
    color: var(--fg-dim);
  }
  /* Boolean setting styled to sit on the same baseline as the select controls. */
  .toggle {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    height: 30px;
    font-size: var(--fs-ui);
    color: var(--fg);
    white-space: nowrap;
    cursor: pointer;
  }
  .toggle input {
    margin: 0;
    cursor: pointer;
  }
  /* Separate the acquisition settings (rate/samples/duration) from the
     per-channel channel/trigger grid, which is visually busy up close. Stretches
     to the full row height rather than sitting on the flex-end baseline. */
  .divider {
    align-self: stretch;
    width: 1px;
    background: var(--border);
  }
  .chan-grid {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .crow {
    display: flex;
    align-items: center;
    gap: 4px;
  }
  /* Holds the row title and (for Trigger) its info affordance, right-aligned so
     the channel/trigger cells below line up. */
  .rowlabel {
    width: 64px;
    flex: none;
    display: inline-flex;
    align-items: center;
    justify-content: flex-end;
    gap: 3px;
    padding-right: 6px;
    font-size: var(--fs-ui);
    color: var(--fg-dim);
  }
  .cell {
    width: 84px;
    flex: none;
    font-size: var(--fs-ui);
    text-align: center;
  }
  .chip {
    padding: 3px 0;
    opacity: 0.5;
  }
  .chip.on {
    opacity: 1;
    border-color: var(--accent-dim);
    color: var(--accent);
  }
  .edge {
    padding: 2px;
  }
  /* Secondary row quick-actions (All/None, Clear) — trailing the cells so the 8
     channel/trigger columns stay aligned; dim and chrome-less so they don't
     compete with the chips/selects. */
  .quick {
    display: inline-flex;
    align-items: center;
    gap: 2px;
    margin-left: 6px;
  }
  .qbtn {
    background: none;
    border: none;
    padding: 2px 4px;
    font-size: var(--fs-ui);
    color: var(--fg-dim);
    cursor: pointer;
  }
  .qbtn:hover {
    color: var(--accent);
  }
  .qsep {
    color: var(--fg-dim);
    opacity: 0.6;
  }
  .warn {
    padding: 6px 14px;
    background: var(--warn-bg);
    color: var(--warn);
    font-size: var(--fs-ui);
    border-bottom: 1px solid var(--border);
  }
</style>
