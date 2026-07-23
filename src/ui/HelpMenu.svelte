<script lang="ts">
  import { loadDemo, activeTab } from "../stores/session";

  let open = $state(false);
  let el: HTMLElement | undefined = $state();

  function onWinClick(e: MouseEvent) {
    if (open && el && !el.contains(e.target as Node)) open = false;
  }

  function runDemo() {
    activeTab.set("analyzer");
    loadDemo();
    open = false;
  }
</script>

<svelte:window
  onclick={onWinClick}
  onkeydown={(e) => e.key === "Escape" && (open = false)}
/>

<div class="help" bind:this={el}>
  <button
    class="help-btn"
    title="Help & demo"
    aria-haspopup="true"
    aria-expanded={open}
    aria-label="Help and demo"
    onclick={() => (open = !open)}>?</button
  >
  {#if open}
    <div class="popover">
      <div class="title"><strong>Web</strong> Logic Analyzer</div>
      <p class="note">
        A browser-based logic analyzer for FX2LP (<span class="mono"
          >fx2lafw</span
        >) devices over WebUSB — capture 8 channels, view, and decode UART / SPI
        / I²C / 1-Wire / CAN.
      </p>

      <button class="demo" onclick={runDemo}>Load demo capture</button>
      <p class="note">
        No hardware needed — loads a sample capture with one exchange per
        protocol and adds every decoder, pre-wired.
      </p>

      <a
        class="link"
        href="https://github.com/lassebm/web-logic-analyzer"
        target="_blank"
        rel="noopener noreferrer">Documentation &amp; source ↗</a
      >
    </div>
  {/if}
</div>

<style>
  .help {
    position: relative;
    /* No auto margin here: the status group's margin-left:auto already pushes
       everything to the right edge, so this just trails it (header `gap` spaces
       them). When status is absent (WebUSB unsupported) the message carries the
       auto margin instead. A second auto here would split the slack and strand
       the status text mid-bar. */
  }
  .help-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 26px;
    height: 26px;
    padding: 0;
    border-radius: 50%;
    font-size: var(--fs-ui);
    color: var(--fg-dim);
  }
  .popover {
    position: absolute;
    top: calc(100% + 6px);
    right: 0;
    z-index: 30;
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 12px;
    background: var(--bg-elev);
    border: 1px solid var(--border);
    border-radius: 8px;
    box-shadow: var(--shadow-pop);
    width: 300px;
  }
  .title {
    font-size: var(--fs-body);
    color: var(--fg-dim);
  }
  .title strong {
    color: var(--accent);
  }
  .note {
    margin: 0;
    font-size: var(--fs-ui);
    color: var(--fg-dim);
    line-height: 1.45;
  }
  .demo {
    align-self: flex-start;
    background: var(--accent);
    color: var(--bg);
    font-size: var(--fs-ui);
    font-weight: 600;
  }
  .link {
    font-size: var(--fs-ui);
    color: var(--accent);
    text-decoration: none;
  }
  .link:hover {
    text-decoration: underline;
  }
</style>
