<script lang="ts">
  import { onDestroy } from "svelte";
  import { connStatus, captureStatus } from "../stores/session";
  import {
    monitorActive,
    monitorLines,
    monitorConfig,
    monitorStartEpoch,
    startMonitor,
    stopMonitor,
    clearMonitor,
    setMonitorGap,
    setNewlineOnIdle,
    pickMonitorRate,
  } from "../stores/monitor";
  import { neutralizeFormula } from "../monitor/terminal";
  import { CHANNEL_NAMES, NUM_CHANNELS } from "../usb/constants";
  import { formatSampleRate } from "../usb/sampleRate";
  import { downloadText } from "../export/download";
  import EditableSelect from "./EditableSelect.svelte";

  const BAUDS = [9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600];

  let termEl: HTMLDivElement | undefined = $state();
  let stickBottom = $state(true);

  function onScroll() {
    if (!termEl) return;
    stickBottom =
      termEl.scrollHeight - termEl.scrollTop - termEl.clientHeight < 30;
  }
  // Keep the terminal pinned to the bottom as the log grows. $effect runs after
  // the DOM is patched, so scrollHeight already reflects the new lines.
  $effect(() => {
    void $monitorLines;
    if (termEl && stickBottom) termEl.scrollTop = termEl.scrollHeight;
  });

  const pad2 = (n: number) => n.toString().padStart(2, "0");
  const pad3 = (n: number) => n.toString().padStart(3, "0");

  function fmtWall(epoch: number, t: number): string {
    const d = new Date(epoch + t * 1000);
    return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}.${pad3(d.getMilliseconds())}`;
  }
  const fmtFromStart = (t: number) => `${t.toFixed(3)}s`;
  const fmtSinceLast = (dt: number) => `+${dt.toFixed(3)}s`;
  const fmtHex = (bytes: number[]) =>
    bytes.map((b) => b.toString(16).toUpperCase().padStart(2, "0")).join(" ");

  let effectiveRate = $derived(pickMonitorRate($monitorConfig.baud));
  let canStart = $derived(
    $connStatus === "ready" && !$monitorActive && $captureStatus !== "running",
  );

  function buildExport(): string {
    const header: string[] = [];
    if ($monitorConfig.tsWall) header.push("wall");
    if ($monitorConfig.tsFromStart) header.push("from_start");
    if ($monitorConfig.tsSinceLast) header.push("since_last");
    if ($monitorConfig.showHex) header.push("hex");
    if ($monitorConfig.showText) header.push("text");
    const out = [header.join("\t")];
    $monitorLines.forEach((line, i) => {
      const row: string[] = [];
      if ($monitorConfig.tsWall) row.push(fmtWall($monitorStartEpoch, line.t));
      if ($monitorConfig.tsFromStart) row.push(fmtFromStart(line.t));
      if ($monitorConfig.tsSinceLast)
        row.push(fmtSinceLast(i > 0 ? line.t - $monitorLines[i - 1].t : 0));
      if ($monitorConfig.showHex) row.push(fmtHex(line.bytes));
      if ($monitorConfig.showText) row.push(neutralizeFormula(line.text));
      out.push(row.join("\t"));
    });
    return out.join("\n");
  }

  // Two-step confirm so Clear can't wipe the log by accident. Once armed, any
  // click elsewhere, the Escape key, or a 3s timeout cancels it.
  let confirmingClear = $state(false);
  let clearTimer: ReturnType<typeof setTimeout> | undefined = $state();

  function cancelConfirm() {
    confirmingClear = false;
    clearTimeout(clearTimer);
    window.removeEventListener("click", onGlobalClick);
    window.removeEventListener("keydown", onGlobalKey);
  }
  function onGlobalClick() {
    cancelConfirm();
  }
  function onGlobalKey(e: KeyboardEvent) {
    if (e.key === "Escape") cancelConfirm();
  }

  function clickClear(e: MouseEvent) {
    if (confirmingClear) {
      clearMonitor();
      cancelConfirm();
      return;
    }
    confirmingClear = true;
    e.stopPropagation(); // don't let this same click immediately cancel
    window.addEventListener("click", onGlobalClick);
    window.addEventListener("keydown", onGlobalKey);
    clearTimer = setTimeout(cancelConfirm, 3000);
  }

  onDestroy(cancelConfirm);

  let copied = $state(false);
  async function copyLog() {
    try {
      await navigator.clipboard.writeText(buildExport());
      copied = true;
      setTimeout(() => (copied = false), 1200);
    } catch {
      /* clipboard denied */
    }
  }

  function downloadLog() {
    downloadText("serial-log.tsv", buildExport(), "text/tab-separated-values");
  }
  let lockedReason = $derived(
    $connStatus !== "ready"
      ? "Connect a device first."
      : $captureStatus === "running"
        ? "Stop the logic capture first."
        : "",
  );
</script>

<div class="monitor">
  <div class="settings">
    <label
      >Ch
      <select bind:value={$monitorConfig.channel} disabled={$monitorActive}>
        {#each Array(NUM_CHANNELS) as _, ch (ch)}<option value={ch}
            >{CHANNEL_NAMES[ch]}</option
          >{/each}
      </select>
    </label>
    <label
      >Baud
      <EditableSelect
        value={$monitorConfig.baud}
        options={BAUDS}
        numeric
        disabled={$monitorActive}
        ariaLabel="Baud"
        onchange={(v) =>
          monitorConfig.update((c) => ({ ...c, baud: v as number }))}
      />
    </label>
    <label
      >Data
      <select bind:value={$monitorConfig.dataBits} disabled={$monitorActive}>
        {#each [5, 6, 7, 8, 9] as n (n)}<option value={n}>{n}</option>{/each}
      </select>
    </label>
    <label
      >Parity
      <select bind:value={$monitorConfig.parity} disabled={$monitorActive}>
        <option value="none">None</option>
        <option value="odd">Odd</option>
        <option value="even">Even</option>
      </select>
    </label>
    <label
      >Stop
      <select bind:value={$monitorConfig.stopBits} disabled={$monitorActive}>
        {#each [1, 2] as n (n)}<option value={n}>{n}</option>{/each}
      </select>
    </label>
    <label
      >Bit order
      <select bind:value={$monitorConfig.bitOrder} disabled={$monitorActive}>
        <option value="lsb-first">LSB first</option>
        <option value="msb-first">MSB first</option>
      </select>
    </label>
    <label class="chk"
      ><input
        type="checkbox"
        checked={$monitorConfig.invert === "yes"}
        onchange={(e) =>
          ($monitorConfig.invert = e.currentTarget.checked ? "yes" : "no")}
        disabled={$monitorActive}
      /> Invert</label
    >

    <span class="divider"></span>

    <label
      class="chk"
      title="Start a new line when the pause between received bytes is longer than the set time. Turn off to break lines only on line-feed."
    >
      <input
        type="checkbox"
        checked={$monitorConfig.newlineOnIdle}
        onchange={(e) => setNewlineOnIdle(e.currentTarget.checked)}
      /> New line after idle
    </label>
    <label title="Idle time that triggers a new line.">
      <input
        type="number"
        min="1"
        step="10"
        value={$monitorConfig.gapMs}
        disabled={!$monitorConfig.newlineOnIdle}
        oninput={(e) => setMonitorGap(Number(e.currentTarget.value))}
        style="width:60px"
      /> ms
    </label>

    <span class="divider"></span>

    <span
      class="rate"
      title="Logic sampling rate used to decode this baud (~8× oversampling)."
    >
      Sample rate: {formatSampleRate(effectiveRate)}
    </span>

    <span class="spacer"></span>

    {#if $monitorActive}
      <button class="danger" onclick={stopMonitor}>Stop</button>
    {:else}
      <button
        class="primary"
        onclick={startMonitor}
        disabled={!canStart}
        title={lockedReason}>Start</button
      >
    {/if}
    <button onclick={copyLog} title="Copy the shown columns to the clipboard"
      >{copied ? "Copied" : "Copy"}</button
    >
    <button
      onclick={downloadLog}
      title="Download the shown columns as a .tsv file">Download</button
    >
    <button
      class:danger={confirmingClear}
      onclick={clickClear}
      title="Clear all lines"
    >
      {confirmingClear ? "Confirm clear?" : "Clear"}
    </button>
  </div>

  <div class="cols">
    <span class="ctitle">Columns:</span>
    <label class="chk"
      ><input type="checkbox" bind:checked={$monitorConfig.tsWall} /> Wall time</label
    >
    <label class="chk"
      ><input type="checkbox" bind:checked={$monitorConfig.tsFromStart} /> From start</label
    >
    <label class="chk"
      ><input type="checkbox" bind:checked={$monitorConfig.tsSinceLast} /> Since last</label
    >
    <label class="chk"
      ><input type="checkbox" bind:checked={$monitorConfig.showHex} /> Hex</label
    >
    <label class="chk"
      ><input type="checkbox" bind:checked={$monitorConfig.showText} /> Text</label
    >
  </div>

  <div class="term mono" bind:this={termEl} onscroll={onScroll}>
    {#each $monitorLines as line, i (i)}
      <div class="row">
        {#if $monitorConfig.tsWall}<span class="col ts"
            >{fmtWall($monitorStartEpoch, line.t)}</span
          >{/if}
        {#if $monitorConfig.tsFromStart}<span class="col ts"
            >{fmtFromStart(line.t)}</span
          >{/if}
        {#if $monitorConfig.tsSinceLast}<span class="col ts"
            >{fmtSinceLast(i > 0 ? line.t - $monitorLines[i - 1].t : 0)}</span
          >{/if}
        {#if $monitorConfig.showHex}<span class="col hex"
            >{fmtHex(line.bytes)}</span
          >{/if}
        {#if $monitorConfig.showText}<span class="col txt">{line.text}</span
          >{/if}
      </div>
    {/each}
    {#if $monitorLines.length === 0}
      <div class="hint">
        {#if $monitorActive}Waiting for serial data…{:else if lockedReason}{lockedReason}{:else}Set
          the UART parameters, then Start. New lines begin after an idle gap (if
          enabled) or a line-feed.{/if}
      </div>
    {/if}
  </div>
</div>

<style>
  .monitor {
    flex: 1;
    display: flex;
    flex-direction: column;
    height: 100%;
    min-width: 0;
    min-height: 0;
  }
  .settings,
  .cols {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 8px 14px;
    border-bottom: 1px solid var(--border);
    background: var(--bg-panel);
    flex-wrap: wrap;
  }
  .cols {
    gap: 16px;
    font-size: var(--fs-ui);
  }
  .ctitle {
    color: var(--fg-dim);
    font-size: var(--fs-ui);
  }
  .rate {
    color: var(--fg-dim);
    font-size: var(--fs-ui); /* match the settings labels */
  }
  label {
    display: inline-flex;
    align-items: center;
    gap: 4px;
  }
  .chk {
    gap: 6px;
  }
  .divider {
    width: 1px;
    height: 20px;
    background: var(--border);
  }
  .spacer {
    flex: 1;
  }
  .term {
    flex: 1;
    overflow-y: auto;
    padding: 8px 14px;
    font-size: var(--fs-ui);
    line-height: 1.55;
    background: var(--bg);
  }
  .row {
    display: flex;
    gap: 14px;
    white-space: pre-wrap;
    word-break: break-all;
  }
  .col.ts {
    color: var(--fg-dim);
    flex: none;
    user-select: none;
    white-space: nowrap;
  }
  .col.hex {
    color: var(--warn);
    flex: none;
    white-space: pre-wrap;
  }
  .col.txt {
    color: var(--fg);
    flex: 1;
  }
  .hint {
    color: var(--fg-dim);
  }
</style>
