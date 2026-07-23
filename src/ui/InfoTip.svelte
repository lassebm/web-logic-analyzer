<script lang="ts">
  // A small ⓘ affordance that reveals a popover on hover/focus, opening
  // downward. Shared by places near the top of the layout (toolbar, panel
  // headers). Content goes in the default slot; `label` is the button's
  // accessible name, `width` the popover width in px.
  import type { Snippet } from "svelte";
  interface Props {
    label: string;
    width?: number;
    children?: Snippet;
  }
  let { label, width = 280, children }: Props = $props();
</script>

<span class="info-tip">
  <button class="tip" type="button" aria-label={label}>ⓘ</button>
  <span class="tip-pop" role="tooltip" style="width:{width}px">
    {@render children?.()}
  </span>
</span>

<style>
  .info-tip {
    position: relative;
    display: inline-flex;
  }
  .tip {
    display: inline-flex;
    align-items: center;
    background: none;
    border: none;
    padding: 0 2px;
    color: var(--fg-dim);
    font-size: var(--fs-ui);
    cursor: help;
  }
  .tip:hover,
  .tip:focus {
    color: var(--accent);
    border-color: transparent;
  }
  .tip-pop {
    display: none;
    position: absolute;
    top: calc(100% + 6px);
    left: 0;
    padding: 10px 12px;
    background: var(--bg-elev);
    border: 1px solid var(--border);
    border-radius: 8px;
    color: var(--fg-dim);
    font-size: var(--fs-ui);
    line-height: 1.5;
    text-align: left;
    box-shadow: var(--shadow-pop);
    z-index: 40;
    white-space: normal;
  }
  .tip-pop :global(strong) {
    color: var(--fg);
  }
  .info-tip:hover .tip-pop,
  .info-tip:focus-within .tip-pop {
    display: block;
  }
</style>
