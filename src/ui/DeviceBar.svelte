<script lang="ts">
  import { onMount } from "svelte";
  import {
    connStatus,
    statusMessage,
    deviceLabel,
    firmwareInfo,
    fwUploadProgress,
    connect,
    finishConnect,
    disconnect,
    tryReconnect,
    watchUsbDisconnect,
    refreshFirmware,
  } from "../stores/session";
  import { Fx2Device } from "../usb/fx2Device";
  import { saveFirmware, clearFirmware } from "../usb/firmwareStore";
  import { FIRMWARE_VERSION, FIRMWARE_SOURCE_URL } from "../firmware";
  import HelpMenu from "./HelpMenu.svelte";

  let fileInput: HTMLInputElement | undefined = $state();
  let fwMenuOpen = $state(false);
  let fwEl: HTMLElement | undefined = $state();
  const supported = Fx2Device.isSupported();

  // Close the firmware popover on an outside click or Escape (same pattern as
  // the decoder add-list).
  function onWinClick(e: MouseEvent) {
    if (fwMenuOpen && fwEl && !fwEl.contains(e.target as Node))
      fwMenuOpen = false;
  }

  onMount(async () => {
    await refreshFirmware();
    if (supported) {
      watchUsbDisconnect();
      await tryReconnect();
    }
  });

  async function onFirmwareFile(e: Event) {
    const file = (e.target as HTMLInputElement).files?.[0];
    if (!file) return;
    try {
      await saveFirmware(file);
      await refreshFirmware();
    } catch (err) {
      statusMessage.set(
        err instanceof Error ? err.message : "Failed to save firmware.",
      );
    }
    fwMenuOpen = false;
  }

  async function onClearFirmware() {
    try {
      await clearFirmware();
      await refreshFirmware();
    } catch (err) {
      statusMessage.set(
        err instanceof Error ? err.message : "Failed to clear firmware.",
      );
    }
    fwMenuOpen = false;
  }

  let statusColor = $derived.by(() => {
    if ($connStatus === "ready") return "var(--ok)";
    if ($connStatus === "error") return "var(--danger)";
    if ($connStatus === "need-firmware" || $connStatus === "reselect")
      return "var(--warn)";
    return "var(--fg-dim)";
  });
</script>

<svelte:window
  onclick={onWinClick}
  onkeydown={(e) => e.key === "Escape" && (fwMenuOpen = false)}
/>

<header class="bar">
  <div class="brand">
    <strong>Web</strong> Logic Analyzer
  </div>

  {#if !supported}
    <span class="msg unsupported" style="color:var(--danger)">
      WebUSB unavailable — use Chrome, Edge, or another Chromium browser.
    </span>
  {:else}
    <div class="group">
      {#if $connStatus === "ready"}
        <button class="danger" onclick={disconnect}>Disconnect</button>
        <span class="dev mono">{$deviceLabel}</span>
      {:else if $connStatus === "reselect"}
        <!-- Firmware uploaded; the re-enumerated device needs one manual pick to
             grant its new fx2lafw identity (WebUSB can't do it automatically). -->
        <button class="primary" onclick={finishConnect}
          >Finish connecting</button
        >
      {:else}
        <button
          class="primary"
          onclick={connect}
          disabled={$connStatus === "connecting"}
        >
          {$connStatus === "connecting" ? "Connecting…" : "Connect device"}
        </button>
      {/if}
    </div>

    <div class="group fw-group" bind:this={fwEl}>
      <!-- Firmware is bundled by default (auto-selected by device); custom is optional. -->
      <button
        class="fw-chip"
        title="Firmware options"
        aria-haspopup="true"
        aria-expanded={fwMenuOpen}
        onclick={() => (fwMenuOpen = !fwMenuOpen)}
      >
        Firmware: {$firmwareInfo ? "custom" : "bundled"}
      </button>
      {#if fwMenuOpen}
        <div class="popover">
          {#if $firmwareInfo}
            <div class="fw-name" title={$firmwareInfo.name}>
              Custom: {$firmwareInfo.name} · {(
                $firmwareInfo.size / 1024
              ).toFixed(0)} KB
            </div>
            <button onclick={() => fileInput?.click()}
              >Replace custom .fw…</button
            >
            <button onclick={onClearFirmware}
              >Use bundled (remove custom)</button
            >
          {:else}
            <div class="fw-note">
              Bundled: sigrok fx2lafw {FIRMWARE_VERSION} — auto-selected by device.
            </div>
            <button onclick={() => fileInput?.click()}>Load custom .fw…</button>
          {/if}
          <a
            class="fw-link"
            href={FIRMWARE_SOURCE_URL}
            target="_blank"
            rel="noopener noreferrer"
          >
            Firmware source &amp; license (GPLv2+) ↗
          </a>
        </div>
      {/if}
      <input
        bind:this={fileInput}
        type="file"
        accept=".fw,application/octet-stream"
        onchange={onFirmwareFile}
        hidden
      />
    </div>

    <div class="status" style="--dot:{statusColor}">
      <span class="dot"></span>
      <span class="msg">{$statusMessage || $connStatus}</span>
      {#if $connStatus === "connecting" && $fwUploadProgress > 0 && $fwUploadProgress < 1}
        <span class="msg mono">{Math.round($fwUploadProgress * 100)}%</span>
      {/if}
    </div>
  {/if}

  <HelpMenu />
</header>

<style>
  .bar {
    display: flex;
    align-items: center;
    gap: 18px;
    padding: 8px 14px;
    background: var(--bg-panel);
    border-bottom: 1px solid var(--border);
    flex-wrap: wrap;
  }
  .brand {
    font-size: var(--fs-title);
    color: var(--fg-dim);
  }
  .brand strong {
    color: var(--accent);
  }
  .group {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .fw-group {
    position: relative;
  }
  .dev {
    font-size: var(--fs-ui);
    color: var(--fg-dim);
    max-width: 260px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .fw-chip {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: var(--fs-ui);
    color: var(--fg-dim);
    padding: 4px 10px;
  }
  .popover {
    position: absolute;
    top: calc(100% + 6px);
    left: 0;
    z-index: 30;
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 10px;
    background: var(--bg-elev);
    border: 1px solid var(--border);
    border-radius: 8px;
    box-shadow: var(--shadow-pop);
    min-width: 280px;
  }
  /* Keep everything in the popover the same size and font. */
  .popover,
  .popover button,
  .popover a {
    font-size: var(--fs-ui);
  }
  /* Hug the label and left-align rather than stretching full width — matches the
     Help popover's action button and reads lighter for these short labels. */
  .popover button {
    align-self: flex-start;
  }
  .fw-name {
    font-size: var(--fs-ui);
    color: var(--fg-dim);
    max-width: 260px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .fw-note {
    font-size: var(--fs-ui);
    color: var(--fg-dim);
    line-height: 1.4;
    white-space: normal;
  }
  /* Same link styling in both the empty state and the popover. */
  .fw-link {
    font-size: var(--fs-ui);
    color: var(--accent);
    text-decoration: none;
  }
  .fw-link:hover {
    text-decoration: underline;
  }
  .status {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-left: auto;
  }
  .dot {
    width: 9px;
    height: 9px;
    border-radius: 50%;
    background: var(--dot);
  }
  .msg {
    font-size: var(--fs-ui);
    color: var(--fg-dim);
  }
  /* With no status group to carry it, the unsupported notice owns the auto
     margin so the Help button still lands at the far right. */
  .unsupported {
    margin-right: auto;
  }
</style>
