<script lang="ts">
  import { captureBuffer, captureTick, config } from "../stores/session";
  import { csvChunks } from "../export/csv";
  import { vcdChunks } from "../export/vcd";
  import {
    downloadChunks,
    streamChunksToDisk,
    canStreamToDisk,
  } from "../export/stream";

  function enabledChannels(): number[] {
    return $config.enabledChannels
      .map((on, i) => (on ? i : -1))
      .filter((i) => i >= 0);
  }

  let busy = $state(false);
  let progress = $state(0); // 0..1
  let error = $state("");

  // Writes straight to a file the user picks when the browser allows it: a
  // 100M-sample CSV is gigabytes, and accumulating that in memory (the Blob
  // fallback) exceeds the renderer heap and kills the tab.
  async function run(kind: "csv" | "vcd") {
    const buf = $captureBuffer;
    if (!buf || busy) return;
    busy = true;
    progress = 0;
    error = "";
    try {
      const chans = enabledChannels();
      const total = buf.sampleCount;
      const set = (f: number) => (progress = f);
      const name = kind === "csv" ? "capture.csv" : "capture.vcd";
      const mime = kind === "csv" ? "text/csv" : "text/plain";
      const chunks =
        kind === "csv" ? csvChunks(buf, chans) : vcdChunks(buf, chans);
      if (canStreamToDisk()) {
        await streamChunksToDisk(name, mime, total, chunks, set);
      } else {
        await downloadChunks(name, mime, total, chunks, set);
      }
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    } finally {
      busy = false;
    }
  }

  // The `$captureTick < 0` term (always false) keeps this reactive to ticks,
  // since the buffer fills by mutation rather than by re-setting the store.
  let disabled = $derived(
    $captureTick < 0 || ($captureBuffer?.sampleCount ?? 0) === 0,
  );
</script>

<div class="export">
  <span class="lbl">Export</span>
  <button disabled={disabled || busy} onclick={() => run("csv")}>CSV</button>
  <button disabled={disabled || busy} onclick={() => run("vcd")}>VCD</button>
  {#if busy}
    <span class="progress" role="status" aria-live="polite">
      {Math.round(progress * 100)}%
    </span>
  {:else if error}
    <span class="err" role="alert">{error}</span>
  {/if}
</div>

<style>
  .export {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .lbl {
    color: var(--fg-dim);
    font-size: var(--fs-ui);
  }
  .progress {
    color: var(--fg-dim);
    font-family: var(--mono);
    font-size: var(--fs-ui);
    min-width: 3ch;
  }
  .err {
    color: var(--warn);
    font-size: var(--fs-ui);
    max-width: 32ch;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
</style>
