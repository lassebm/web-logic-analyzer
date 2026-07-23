<script lang="ts">
  import {
    decoders,
    addDecoder,
    removeDecoder,
    moveDecoder,
    updateDecoder,
    setDecoderEnabled,
    setAllDecodersEnabled,
    decodersEnabled,
    config,
  } from "../stores/session";
  import { DECODERS, getDecoder } from "../decode/registry";
  import { CHANNEL_NAMES, NUM_CHANNELS } from "../usb/constants";
  import EditableSelect from "./EditableSelect.svelte";

  let open = $state(false);
  let adderEl: HTMLElement | undefined = $state();

  // Drag-to-reorder state. Only the grip handle is draggable, so the row's inputs
  // stay usable; the whole row is used as the drag image for a clear visual.
  let dragUid: string | null = $state(null);
  let dragOverUid: string | null = $state(null);

  function onDragStart(e: DragEvent, uid: string) {
    dragUid = uid;
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", uid);
      const row = (e.currentTarget as HTMLElement).closest(".inst");
      if (row) e.dataTransfer.setDragImage(row, 12, 12);
    }
  }

  function onDragOver(e: DragEvent, uid: string) {
    if (!dragUid || dragUid === uid) return;
    e.preventDefault(); // allow the drop
    if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
    dragOverUid = uid;
  }

  function onDrop(e: DragEvent, index: number) {
    e.preventDefault();
    if (dragUid) moveDecoder(dragUid, index);
    dragUid = null;
    dragOverUid = null;
  }

  function onDragEnd() {
    dragUid = null;
    dragOverUid = null;
  }

  // Keyboard fallback for reordering (accessibility): arrow keys move the row.
  function onHandleKey(e: KeyboardEvent, uid: string, index: number) {
    if (e.key === "ArrowUp" || e.key === "ArrowDown") {
      e.preventDefault();
      moveDecoder(uid, index + (e.key === "ArrowUp" ? -1 : 1));
    }
  }

  function pick(id: string) {
    addDecoder(id);
    open = false;
  }

  // Close the add-list when clicking elsewhere or pressing Escape.
  function onWinClick(e: MouseEvent) {
    if (open && adderEl && !adderEl.contains(e.target as Node)) open = false;
  }

  // Friendly display labels for enum option values (the stored values stay as-is).
  const VALUE_LABELS: Record<string, string> = {
    none: "None",
    odd: "Odd",
    even: "Even",
    "lsb-first": "LSB first",
    "msb-first": "MSB first",
    no: "No",
    yes: "Yes",
    "active-low": "Active low",
    "active-high": "Active high",
    standard: "Standard",
    overdrive: "Overdrive",
  };
  function optLabel(v: string | number): string {
    if (typeof v === "number") return String(v);
    return VALUE_LABELS[v] ?? v.charAt(0).toUpperCase() + v.slice(1);
  }

  function onChannel(uid: string, logical: number, phys: number) {
    const inst = $decoders.find((d) => d.uid === uid);
    if (!inst) return;
    const channelMap = [...inst.channelMap];
    channelMap[logical] = phys;
    updateDecoder(uid, { channelMap });
  }

  function onOption(uid: string, id: string, value: string) {
    const inst = $decoders.find((d) => d.uid === uid);
    if (!inst) return;
    const dec = getDecoder(inst.decoderId)!;
    const def = dec.meta.options.find((o) => o.id === id)!;
    const coerced = typeof def.default === "number" ? Number(value) : value;
    updateDecoder(uid, { options: { ...inst.options, [id]: coerced } });
  }

  // Instances that emit the packet type a stacked decoder consumes.
  function sourcesFor(inputType: string) {
    return $decoders.filter(
      (i) => getDecoder(i.decoderId)?.meta.outputType === inputType,
    );
  }

  // Decoder types capable of feeding a stacked decoder (emit its inputType),
  // used to tell the user what to add when no source instance exists yet.
  function compatibleSourceNames(inputType: string) {
    return DECODERS.filter((d) => d.meta.outputType === inputType).map(
      (d) => d.meta.name,
    );
  }
</script>

<svelte:window
  onclick={onWinClick}
  onkeydown={(e) => e.key === "Escape" && (open = false)}
/>

<section class="panel">
  <div class="adder" bind:this={adderEl}>
    <div class="head">
      <strong>Decoders</strong>
      <label
        class="enable-all"
        title="Enable/disable all decoders (both live and on stop)."
      >
        <input
          type="checkbox"
          checked={$decodersEnabled}
          onchange={(e) => setAllDecodersEnabled(e.currentTarget.checked)}
        />
        On
      </label>
      <span class="grow"></span>
      <button
        class="add-toggle"
        aria-haspopup="true"
        aria-expanded={open}
        onclick={() => (open = !open)}
      >
        + Add decoder
      </button>
    </div>
    {#if open}
      <!-- Descriptions are visible for every decoder while choosing — the point of
           deciding — rather than hidden behind a hover on a cramped picker. -->
      <ul class="add-list">
        {#each DECODERS as d (d.meta.id)}
          <li>
            <button class="add-item" onclick={() => pick(d.meta.id)}>
              <span class="add-name">{d.meta.name}</span>
              <span class="add-desc">{d.meta.desc}</span>
            </button>
          </li>
        {/each}
      </ul>
    {/if}
  </div>

  {#each $decoders as inst, i (inst.uid)}
    {@const dec = getDecoder(inst.decoderId)}
    {#if dec}
      <div
        class="inst"
        class:dragging={dragUid === inst.uid}
        class:drag-over={dragOverUid === inst.uid}
        ondragover={(e) => onDragOver(e, inst.uid)}
        ondrop={(e) => onDrop(e, i)}
        role="group"
        aria-label={inst.label}
      >
        <div class="inst-head">
          <button
            class="drag-handle"
            aria-label="Reorder decoder (drag, or use arrow keys)"
            title="Drag to reorder"
            draggable="true"
            ondragstart={(e) => onDragStart(e, inst.uid)}
            ondragend={onDragEnd}
            onkeydown={(e) => onHandleKey(e, inst.uid, i)}
          >
            ⠿
          </button>
          <input
            class="name"
            value={inst.label}
            aria-label="Decoder name"
            title={dec.meta.name}
            onchange={(e) =>
              updateDecoder(inst.uid, { label: e.currentTarget.value })}
          />
          <label
            class="enable"
            title="Enable/disable this decoder"
            class:muted={!$decodersEnabled}
          >
            <input
              type="checkbox"
              checked={inst.enabled !== false}
              disabled={!$decodersEnabled}
              onchange={(e) =>
                setDecoderEnabled(inst.uid, e.currentTarget.checked)}
            />
            On
          </label>
          <button class="danger sm" onclick={() => removeDecoder(inst.uid)}
            >Remove</button
          >
        </div>

        <div class="rows">
          {#if dec.meta.inputType}
            {@const srcs = sourcesFor(dec.meta.inputType)}
            <div class="row">
              <span class="lbl">Source</span>
              {#if srcs.length > 0}
                <select
                  value={inst.stackOnUid ?? ""}
                  onchange={(e) =>
                    updateDecoder(inst.uid, {
                      stackOnUid: e.currentTarget.value,
                    })}
                >
                  {#each srcs as s (s.uid)}
                    <option value={s.uid}>{s.label}</option>
                  {/each}
                </select>
              {:else}
                <span class="missing">None</span>
              {/if}
            </div>
            {#if srcs.length === 0}
              <p class="src-hint">
                Needs a source that emits {dec.meta.inputType} data. Add one first:
                {compatibleSourceNames(dec.meta.inputType).join(", ")}.
              </p>
            {/if}
          {/if}

          {#each dec.meta.channels as chDef, logical (chDef.id)}
            <div class="row">
              <span class="lbl">{chDef.name}</span>
              <select
                value={inst.channelMap[logical]}
                onchange={(e) =>
                  onChannel(inst.uid, logical, Number(e.currentTarget.value))}
              >
                {#each Array(NUM_CHANNELS) as _, phys (phys)}
                  <option
                    value={phys}
                    disabled={!$config.enabledChannels[phys]}
                  >
                    {CHANNEL_NAMES[phys]}
                  </option>
                {/each}
              </select>
            </div>
          {/each}

          {#each dec.meta.options as opt (opt.id)}
            <div class="row">
              <span class="lbl">{opt.desc}</span>
              {#if opt.values}
                <select
                  value={String(inst.options[opt.id])}
                  onchange={(e) =>
                    onOption(inst.uid, opt.id, e.currentTarget.value)}
                >
                  {#each opt.values as v (v)}
                    <option value={String(v)}>{optLabel(v)}</option>
                  {/each}
                </select>
              {:else if opt.presets}
                <!-- Preset dropdown that also accepts a custom value. -->
                <EditableSelect
                  value={inst.options[opt.id]}
                  options={opt.presets}
                  numeric={typeof opt.default === "number"}
                  width="120px"
                  ariaLabel={opt.desc}
                  onchange={(v) =>
                    updateDecoder(inst.uid, {
                      options: { ...inst.options, [opt.id]: v },
                    })}
                />
              {:else}
                <input
                  type="text"
                  value={String(inst.options[opt.id])}
                  onchange={(e) =>
                    onOption(inst.uid, opt.id, e.currentTarget.value)}
                />
              {/if}
            </div>
          {/each}
        </div>
        <div class="count">
          {inst.annotations.length} annotations
          <button class="tip" type="button" aria-label="What are annotations?">
            ⓘ
            <span class="tip-pop">
              Annotations are this decoder's decoded results — labelled blocks
              (start bits, data bytes, ACKs, IDs, …) drawn on their own rows
              beneath the waveform, aligned to the samples they came from.
            </span>
          </button>
        </div>
      </div>
    {/if}
  {/each}

  {#if $decoders.length === 0}
    <p class="hint">Add a decoder (e.g. UART) and map it to a channel.</p>
  {/if}
</section>

<style>
  .panel {
    /* No top padding: the sticky header supplies its own, so `top: 0` sticks it
       flush to the panel edge. A container padding-top would make it stick that
       far down and let rows scroll through the gap above it. */
    padding: 0 12px 10px;
    overflow-y: auto;
    height: 100%;
  }
  /* Pin the title + master toggle + "Add decoder" so they stay reachable when a
     long decoder list scrolls. `.adder` is a direct child of the scrolling
     `.panel`, so it sticks for the whole scroll (not just while its own box is in
     view). Full-bleed (negative margins cancel the panel padding) with a divider;
     z-index below the per-decoder ⓘ tooltips (40) so those aren't clipped. */
  .adder {
    position: sticky;
    top: 0;
    z-index: 5;
    margin: 0 -12px 10px;
    padding: 10px 12px 8px;
    background: var(--bg-panel);
    border-bottom: 1px solid var(--border);
  }
  .head {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .head strong {
    margin-right: 6px;
  }
  .grow {
    flex: 1;
  }
  /* Enable/disable toggles: the master one in the header, and a per-decoder one. */
  .enable-all,
  .enable {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font-size: var(--fs-ui);
    color: var(--fg-dim);
    cursor: pointer;
    white-space: nowrap;
  }
  .enable {
    margin-right: 8px;
  }
  .enable.muted {
    opacity: 0.5;
    cursor: default;
  }
  .enable-all input,
  .enable input {
    margin: 0;
    cursor: inherit;
  }
  .add-toggle {
    font-size: var(--fs-ui);
    padding: 4px 10px;
  }
  .add-list {
    list-style: none;
    margin: 8px 0 0;
    padding: 4px;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--bg-elev);
  }
  .add-item {
    display: block;
    width: 100%;
    text-align: left;
    background: none;
    border: none;
    border-radius: 6px;
    padding: 6px 8px;
  }
  .add-item:hover:not(:disabled) {
    background: var(--bg);
    border-color: transparent;
  }
  .add-name {
    display: block;
    font-weight: 600;
  }
  .add-desc {
    display: block;
    margin-top: 2px;
    color: var(--fg-dim);
    font-size: var(--fs-ui);
    line-height: 1.4;
  }
  .inst {
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 8px 10px;
    margin-bottom: 10px;
    background: var(--bg-elev);
  }
  /* The row being dragged fades; the row it would drop onto gets an accent edge. */
  .inst.dragging {
    opacity: 0.4;
  }
  .inst.drag-over {
    border-color: var(--accent);
  }
  .inst-head {
    display: flex;
    align-items: center;
    margin-bottom: 6px;
  }
  .drag-handle {
    cursor: grab;
    background: none;
    border: none;
    color: var(--fg-dim);
    padding: 0 6px 0 0;
    font-size: var(--fs-body);
    line-height: 1;
    display: inline-flex;
    align-items: center;
  }
  .drag-handle:hover,
  .drag-handle:focus {
    color: var(--fg);
  }
  .drag-handle:active {
    cursor: grabbing;
  }
  .inst-head .name {
    flex: 1;
    min-width: 0;
    margin-right: 8px;
    font: inherit;
    font-weight: 600;
    color: var(--fg);
    background: transparent;
    border: 1px solid transparent;
    border-radius: 6px;
    padding: 2px 6px;
  }
  .inst-head .name:hover {
    border-color: var(--border);
  }
  .inst-head .name:focus {
    border-color: var(--accent);
    background: var(--bg);
    outline: none;
  }
  .sm {
    padding: 2px 8px;
    font-size: var(--fs-ui);
  }
  .rows {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }
  .row .lbl {
    flex: 1;
    color: var(--fg-dim);
    font-size: var(--fs-ui);
  }
  .row select,
  .row input {
    width: 120px;
  }
  .count {
    position: relative;
    margin-top: 6px;
    font-size: var(--fs-ui);
    color: var(--fg-dim);
    display: flex;
    align-items: center;
    gap: 4px;
  }
  .tip {
    display: inline-flex;
    align-items: center;
    cursor: help;
    color: var(--fg-dim);
    background: none;
    border: none;
    padding: 0;
    font-size: var(--fs-ui);
  }
  .tip:hover,
  .tip:focus {
    color: var(--accent);
  }
  /* Anchored to the full-width count row (not the icon) and opening upward, so
     the narrow sidebar's clipping can't cut it off. */
  .tip-pop {
    display: none;
    position: absolute;
    left: 0;
    right: 0;
    bottom: calc(100% + 6px);
    padding: 8px 10px;
    background: var(--bg-elev);
    border: 1px solid var(--border);
    border-radius: 8px;
    color: var(--fg-dim);
    font-size: var(--fs-ui);
    line-height: 1.5;
    box-shadow: var(--shadow-pop);
    z-index: 40;
    white-space: normal;
  }
  .tip:hover .tip-pop,
  .tip:focus .tip-pop {
    display: block;
  }
  .hint {
    color: var(--fg-dim);
    font-size: var(--fs-ui);
  }
  .missing {
    width: 120px;
    color: var(--fg-dim);
    font-size: var(--fs-ui);
    font-style: italic;
  }
  .src-hint {
    margin: 2px 0 0;
    color: var(--fg-dim);
    font-size: var(--fs-ui);
    line-height: 1.4;
  }
</style>
