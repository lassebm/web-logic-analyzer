<script lang="ts">
  import { loadCapture, monitorActive } from "../stores/session";
  import { importFile } from "../import/importer";

  let input: HTMLInputElement | undefined = $state();
  let busy = $state(false);
  let progress = $state(0); // 0..1
  let error = $state("");

  async function onFile(e: Event) {
    const el = e.target as HTMLInputElement;
    const file = el.files?.[0];
    el.value = ""; // let the same file be re-selected later
    if (!file) return;
    busy = true;
    progress = 0;
    error = "";
    try {
      const buf = await importFile(file, (f) => (progress = f));
      if (buf.sampleCount === 0)
        throw new Error("No samples found in the file.");
      if (!loadCapture(buf))
        throw new Error("Stop the Serial Monitor before importing.");
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    } finally {
      busy = false;
    }
  }
</script>

<div class="import">
  <span class="lbl">Import</span>
  <button
    disabled={busy || $monitorActive}
    onclick={() => input?.click()}
    title="Load a CSV or VCD capture file"
    >{busy ? "Importing…" : "File…"}</button
  >
  <input
    bind:this={input}
    type="file"
    accept=".csv,.vcd,text/csv,text/plain"
    onchange={onFile}
    hidden
  />
  {#if busy}
    <span class="progress" role="status" aria-live="polite"
      >{Math.round(progress * 100)}%</span
    >
  {:else if error}
    <span class="err" role="alert">{error}</span>
  {/if}
</div>

<style>
  .import {
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
