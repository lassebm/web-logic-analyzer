<script lang="ts">
  import { connStatus, captureStatus, capabilities } from "../stores/session";
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
  import {
    neutralizeFormula,
    mergeContinued,
    MAX_LINE_CHARS,
    type MonitorLine,
  } from "../monitor/terminal";
  import { CHANNEL_NAMES } from "../device/channels";
  import { formatSampleRate } from "../usb/sampleRate";
  import { downloadText } from "../export/download";
  import EditableSelect from "./EditableSelect.svelte";
  import ConfirmButton from "./ConfirmButton.svelte";

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

  // Svelte re-evaluates every row's expressions on each publish, so building hex
  // per tick is O(total bytes) — measured at 30 ms for 10k x 80-byte lines, a
  // third of the main thread, which risks stalling the FX2 FIFO (see the O(chunk)
  // rule in AGENTS.md). Memoized instead: only the last line grows, so the byte
  // count is a sufficient cache key, and a WeakMap lets trimmed lines be freed.
  const hexCache = new WeakMap<MonitorLine, { n: number; s: string }>();
  function fmtHex(line: MonitorLine): string {
    const hit = hexCache.get(line);
    if (hit && hit.n === line.bytes.length) return hit.s;
    const s = line.bytes
      .map((b) => b.toString(16).toUpperCase().padStart(2, "0"))
      .join(" ");
    hexCache.set(line, { n: line.bytes.length, s });
    return s;
  }

  // Iterated by the terminal's {#each} instead of the store directly. Reading a
  // store inside an each-expression makes Svelte treat every item as mutable, so
  // it marks all rows dirty on every publish; via a $derived the items compare by
  // identity and only the rows that actually changed re-render.
  let rows = $derived($monitorLines);

  let effectiveRate = $derived(
    pickMonitorRate($monitorConfig.baud, $capabilities.sampleRates),
  );
  // Why the monitor can't run, or "" when it can — one string behind both the
  // disabled Start button and the hint the empty terminal shows. There is no
  // case here for a device that can't stream continuously: App.svelte hides this
  // whole tab for those, so the panel never renders for one.
  let lockedReason = $derived(
    $connStatus !== "ready"
      ? "Connect a device first."
      : $captureStatus === "running"
        ? "Stop the logic capture first."
        : "",
  );
  let canStart = $derived(!lockedReason && !$monitorActive);

  function buildExport(): string {
    const cfg = $monitorConfig;
    const header: string[] = [];
    if (cfg.tsWall) header.push("wall");
    if (cfg.tsFromStart) header.push("from_start");
    if (cfg.tsSinceLast) header.push("since_last");
    if (cfg.showHex) header.push("hex");
    if (cfg.showText) header.push("text");

    // Export logical records, not scrollback rows: a cap-split line rejoins the
    // one it was split from, so it never reads as a second message.
    const body = mergeContinued($monitorLines).map((line) => {
      const row: string[] = [];
      if (cfg.tsWall) row.push(fmtWall($monitorStartEpoch, line.t));
      if (cfg.tsFromStart) row.push(fmtFromStart(line.t));
      if (cfg.tsSinceLast) row.push(fmtSinceLast(line.dt));
      if (cfg.showHex) row.push(fmtHex(line));
      if (cfg.showText) row.push(neutralizeFormula(line.text));
      return row.join("\t");
    });
    return [header.join("\t"), ...body].join("\n");
  }

  // Both Clear and Start throw the log away, so both ask first (ConfirmButton) —
  // and only when there is a log to lose.
  let hasLog = $derived($monitorLines.length > 0);

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
</script>

<!-- Marks a row the char cap split off the one above, so a device that never
     sends a line-feed doesn't look like it sent two unrelated records. -->
{#snippet contMark()}<span
    class="cont"
    title={`Continues the line above — it reached the ${MAX_LINE_CHARS}-character limit with no line-feed`}
    aria-label="continued line">↳</span
  >{/snippet}

<div class="monitor">
  <div class="settings">
    <label
      >Ch
      <select bind:value={$monitorConfig.channel} disabled={$monitorActive}>
        {#each Array($capabilities.channels) as _, ch (ch)}<option value={ch}
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
        title="Pick a preset, or “Custom…” to type any value"
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
      <ConfirmButton
        class="primary"
        label="Start"
        confirmLabel="Confirm start?"
        onconfirm={startMonitor}
        needsConfirm={hasLog}
        disabled={!canStart}
        title={lockedReason ||
          (hasLog
            ? "Start logging — this clears the lines below, so it asks to confirm"
            : "Start logging")}
      />
    {/if}
    <button onclick={copyLog} title="Copy the shown columns to the clipboard"
      >{copied ? "Copied" : "Copy"}</button
    >
    <button
      onclick={downloadLog}
      title="Download the shown columns as a .tsv file">Download</button
    >
    <ConfirmButton
      label="Clear"
      confirmLabel="Confirm clear?"
      onconfirm={clearMonitor}
      needsConfirm={hasLog}
      title="Clear all lines"
    />
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
    {#each rows as line (line.id)}
      <div class="row">
        {#if $monitorConfig.tsWall}<span class="col ts"
            >{fmtWall($monitorStartEpoch, line.t)}</span
          >{/if}
        {#if $monitorConfig.tsFromStart}<span class="col ts"
            >{fmtFromStart(line.t)}</span
          >{/if}
        {#if $monitorConfig.tsSinceLast}<span class="col ts"
            >{fmtSinceLast(line.dt)}</span
          >{/if}
        {#if $monitorConfig.showHex}<span class="col hex"
            >{#if line.continued && !$monitorConfig.showText}{@render contMark()}{/if}{fmtHex(
              line,
            )}</span
          >{/if}
        {#if $monitorConfig.showText}<span class="col txt"
            >{#if line.continued}{@render contMark()}{/if}{line.text}</span
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
  /* Hugs its content like a fixed column while it is short, but must be allowed
     to shrink and wrap: a line the char cap split is 4096 bytes, i.e. ~12k hex
     characters. Without the cap the row overflows, and .txt (zero flex-basis)
     then gets no space at all and renders blank. Breaking at the spaces between
     bytes rather than mid-byte overrides .row's break-all, which is there for
     decoded text that may have no spaces at all. */
  .col.hex {
    color: var(--warn);
    flex: 0 1 auto;
    min-width: 0;
    max-width: 50%;
    white-space: pre-wrap;
    word-break: normal;
  }
  .col.txt {
    color: var(--fg);
    flex: 1;
    min-width: 0;
  }
  /* Not selectable: copying the text column shouldn't pick up the marker. */
  .cont {
    color: var(--fg-dim);
    user-select: none;
    margin-right: 4px;
  }
  .hint {
    color: var(--fg-dim);
  }
</style>
