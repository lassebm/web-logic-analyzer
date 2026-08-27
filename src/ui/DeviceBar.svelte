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
    watchDeviceDisconnect,
    refreshFirmware,
    backendId,
    setBackend,
  } from "../stores/session";
  import { BACKENDS, getBackend } from "../device/registry";
  import type { BackendId } from "../device/types";
  import { saveFirmware, clearFirmware } from "../usb/firmwareStore";
  import { FIRMWARE_VERSION, FIRMWARE_SOURCE_URL } from "../firmware";
  import HelpMenu from "./HelpMenu.svelte";

  let fileInput: HTMLInputElement | undefined = $state();
  let fwMenuOpen = $state(false);
  let fwEl: HTMLElement | undefined = $state();
  // Which transport the selected backend needs, and whether this browser has it.
  let backend = $derived(getBackend($backendId));
  let supported = $derived(backend.isSupported());

  // Close the firmware popover on an outside click or Escape (same pattern as
  // the decoder add-list).
  function onWinClick(e: MouseEvent) {
    if (fwMenuOpen && fwEl && !fwEl.contains(e.target as Node))
      fwMenuOpen = false;
  }

  onMount(async () => {
    await refreshFirmware();
    // watchDeviceDisconnect() registers with every supported backend and guards
    // itself, so it doesn't depend on which one is selected right now.
    watchDeviceDisconnect();
    if (supported) await tryReconnect();
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

  <div class="group">
    <label class="blabel" for="backend">Device</label>
    <select
      id="backend"
      value={$backendId}
      disabled={$connStatus === "ready"}
      title={$connStatus === "ready"
        ? "Disconnect before switching device family"
        : "Which hardware family Connect talks to"}
      onchange={(e) => setBackend(e.currentTarget.value as BackendId)}
    >
      {#each BACKENDS as b (b.id)}
        <option value={b.id}>{b.name}</option>
      {/each}
    </select>
  </div>

  {#if !supported}
    <span class="msg unsupported" style="color:var(--danger)">
      {backend.unsupportedMessage}
    </span>
  {:else}
    <div class="group">
      {#if $connStatus === "ready"}
        <button class="danger" onclick={disconnect}>Disconnect</button>
        <span class="dev mono" title={$deviceLabel}>{$deviceLabel}</span>
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

    {#if $backendId === "fx2"}
      <!-- Firmware is an FX2 concept: a SUMP device runs its own. -->
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
              <button onclick={() => fileInput?.click()}
                >Load custom .fw…</button
              >
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
    {/if}

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
  .blabel {
    font-size: var(--fs-ui);
    color: var(--fg-dim);
  }
  .group {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .fw-group {
    position: relative;
  }
  /* A SUMP device names itself and its geometry ("… — 8 channels, 262,144
     samples"), far longer than an FX2's "fx2lafw — fw 1.3, rev 1". Room for the
     long form, and a title so anything still clipped is one hover away. */
  .dev {
    font-size: var(--fs-ui);
    color: var(--fg-dim);
    max-width: 420px;
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
  .popover,
  .popover button,
  .popover a {
    font-size: var(--fs-ui);
  }
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
