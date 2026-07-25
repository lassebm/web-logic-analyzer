<script lang="ts">
  // A button that asks first when the action would throw something away: the
  // first click arms it (label swaps to `confirmLabel`, styled as danger), the
  // second commits. Any click elsewhere, Escape, or a few seconds of inactivity
  // disarms it, so an armed button can't sit there waiting to fire. With
  // `needsConfirm` false there is nothing to lose and the first click acts.
  import { onDestroy } from "svelte";

  interface Props {
    label: string;
    confirmLabel: string;
    onconfirm: () => void;
    needsConfirm?: boolean;
    disabled?: boolean;
    title?: string;
    /** Class for the resting state; the armed state always styles as danger. */
    class?: string;
    timeoutMs?: number;
  }

  let {
    label,
    confirmLabel,
    onconfirm,
    needsConfirm = true,
    disabled = false,
    title = "",
    class: klass = "",
    timeoutMs = 3000,
  }: Props = $props();

  let armed = $state(false);
  let timer: ReturnType<typeof setTimeout> | undefined;

  function disarm(): void {
    armed = false;
    clearTimeout(timer);
    window.removeEventListener("click", disarm);
    window.removeEventListener("keydown", onKey);
  }

  function onKey(e: KeyboardEvent): void {
    if (e.key === "Escape") disarm();
  }

  function click(e: MouseEvent): void {
    if (disabled) return; // a real browser won't fire this; jsdom will
    if (!needsConfirm) {
      onconfirm();
      return;
    }
    if (armed) {
      disarm();
      onconfirm();
      return;
    }
    armed = true;
    e.stopPropagation(); // don't let this same click immediately disarm
    window.addEventListener("click", disarm);
    window.addEventListener("keydown", onKey);
    timer = setTimeout(disarm, timeoutMs);
  }

  onDestroy(disarm);
</script>

<button class={armed ? "danger" : klass} {disabled} {title} onclick={click}>
  {armed ? confirmLabel : label}
</button>
