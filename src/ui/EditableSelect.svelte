<script lang="ts">
  // A dropdown of presets that also accepts a custom value. It's a native
  // <select> (so the arrow, sizing, and keyboard behaviour match the app's other
  // selects, and every preset is always listed) with a trailing "Custom…" entry
  // that swaps to a plain text field for typing an arbitrary value. No datalist
  // (which hides presets once a value is set) and no number spinners.
  interface Props {
    value: string | number;
    options: Array<string | number>;
    onchange: (value: string | number) => void;
    numeric?: boolean;
    disabled?: boolean;
    width?: string;
    ariaLabel?: string;
  }
  let {
    value,
    options,
    onchange,
    numeric = false,
    disabled = false,
    width,
    ariaLabel,
  }: Props = $props();

  const CUSTOM = "__custom__"; // sentinel option value, unlikely to collide
  let editing = $state(false);
  let inputEl: HTMLInputElement | undefined = $state();

  // Always show every preset; include the current value too when it's a custom
  // one, so it stays selected and visible in the list.
  let items = $derived(
    options.some((o) => String(o) === String(value))
      ? options
      : [...options, value],
  );

  function coerce(raw: string): string | number {
    return numeric ? Number(raw) : raw;
  }

  function onSelect(e: Event) {
    const v = (e.currentTarget as HTMLSelectElement).value;
    if (v === CUSTOM) {
      editing = true; // reveal the text field (focused by the effect below)
      return;
    }
    onchange(coerce(v));
  }

  function commit(raw: string) {
    const trimmed = raw.trim();
    if (trimmed !== "") {
      const v = coerce(trimmed);
      if (!numeric || (Number.isFinite(v as number) && (v as number) > 0))
        onchange(v);
    }
    editing = false; // back to the dropdown either way
  }

  $effect(() => {
    if (editing && inputEl) {
      inputEl.focus();
      inputEl.select();
    }
  });
</script>

{#if editing}
  <input
    bind:this={inputEl}
    type="text"
    inputmode={numeric ? "numeric" : "text"}
    value={String(value)}
    {disabled}
    aria-label={ariaLabel}
    style={width ? `width:${width}` : undefined}
    onkeydown={(e) => {
      if (e.key === "Enter") commit(e.currentTarget.value);
      else if (e.key === "Escape") editing = false;
    }}
    onblur={(e) => commit(e.currentTarget.value)}
  />
{:else}
  <select
    value={String(value)}
    {disabled}
    aria-label={ariaLabel}
    style={width ? `width:${width}` : undefined}
    onchange={onSelect}
  >
    {#each items as o (o)}
      <option value={String(o)}>{o}</option>
    {/each}
    <option value={CUSTOM}>Custom…</option>
  </select>
{/if}
