<script lang="ts">
  import { captureBuffer, captureTick, config } from "../stores/session";
  import { csvChunks } from "../export/csv";
  import { vcdChunks } from "../export/vcd";
  import { downloadChunks } from "../export/stream";

  function enabledChannels(): number[] {
    return $config.enabledChannels
      .map((on, i) => (on ? i : -1))
      .filter((i) => i >= 0);
  }

  let busy = $state(false);
  let progress = $state(0); // 0..1
  let error = $state("");

  // Streams the export to a Blob off the main thread's critical path (yields
  // between chunks) so a 100M-sample capture doesn't freeze the tab.
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
      if (kind === "csv") {
        await downloadChunks(
          "capture.csv",
          "text/csv",
          total,
          csvChunks(buf, chans),
          set,
        );
      } else {
        await downloadChunks(
          "capture.vcd",
          "text/plain",
          total,
          vcdChunks(buf, chans),
          set,
        );
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
