<script lang="ts">
  import { cursors, captureBuffer } from "../stores/session";

  function fmtTime(seconds: number): string {
    const a = Math.abs(seconds);
    if (a >= 1) return `${seconds.toFixed(4)} s`;
    if (a >= 1e-3) return `${(seconds * 1e3).toFixed(3)} ms`;
    if (a >= 1e-6) return `${(seconds * 1e6).toFixed(3)} µs`;
    return `${(seconds * 1e9).toFixed(1)} ns`;
  }
  function fmtFreq(hz: number): string {
    const a = Math.abs(hz);
    if (a >= 1e6) return `${(hz / 1e6).toFixed(4)} MHz`;
    if (a >= 1e3) return `${(hz / 1e3).toFixed(4)} kHz`;
    return `${hz.toFixed(2)} Hz`;
  }

  let sr = $derived($captureBuffer?.sampleRate ?? 0);
  let haveTwo = $derived($cursors.length === 2 && sr > 0);
  let dtSamples = $derived(haveTwo ? Math.abs($cursors[1] - $cursors[0]) : 0);
  let dt = $derived(haveTwo ? dtSamples / sr : 0);
</script>

<div class="meas mono">
  {#if $cursors.length === 0}
    <span class="hint">Click the waveform to drop measurement cursors.</span>
  {:else}
    {#each $cursors as c, i (i)}
      <span class="tag">C{i + 1}: {sr ? fmtTime(c / sr) : c}</span>
    {/each}
    {#if haveTwo}
      <span class="tag">Δt: {fmtTime(dt)}</span>
      <span class="tag">1/Δt: {dt ? fmtFreq(1 / dt) : "—"}</span>
      <span class="tag">Δ samples: {dtSamples.toLocaleString()}</span>
    {/if}
  {/if}
</div>

<style>
  .meas {
    display: flex;
    gap: 14px;
    align-items: center;
    padding: 6px 14px;
    background: var(--bg-panel);
    border-top: 1px solid var(--border);
    font-size: var(--fs-ui);
    flex-wrap: wrap;
  }
  .tag {
    color: var(--fg);
  }
  .hint {
    color: var(--fg-dim);
  }
</style>
