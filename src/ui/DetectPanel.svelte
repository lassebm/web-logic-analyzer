<script lang="ts">
  import { detections, addDecoder } from "../stores/session";
  import { CHANNEL_NAMES } from "../usb/constants";
  import {
    detectionToDecoder,
    type Detection,
    type UartDetection,
  } from "../decode/detect";
  import InfoTip from "./InfoTip.svelte";

  const PARITY_LETTER = { none: "N", even: "E", odd: "O" } as const;

  // Frame format as data-parity-stop, e.g. "8-N-1". Stop bits are assumed 1:
  // two stop bits are indistinguishable from one stop bit plus idle time.
  function framing(d: UartDetection): string {
    return `${d.data_bits}-${PARITY_LETTER[d.parity]}-1`;
  }

  const PROTO_NAME: Record<Detection["kind"], string> = {
    uart: "UART",
    i2c: "I²C",
  };

  // How each hit names the channel(s) it was found on.
  function channelText(d: Detection): string {
    if (d.kind === "i2c")
      return `SCL ${CHANNEL_NAMES[d.channels[0]]} · SDA ${CHANNEL_NAMES[d.channels[1]]}`;
    return CHANNEL_NAMES[d.channels[0]];
  }

  // What the confidence badge means, per protocol.
  function confTitle(d: Detection): string {
    return d.kind === "i2c"
      ? "Share of clock-high windows where the data line held steady"
      : "Share of frames that decoded without errors";
  }

  // A stable key even when a UART and an I²C pair share a channel.
  function key(d: Detection): string {
    return `${d.kind}:${d.channels.join("-")}`;
  }

  function add(d: Detection) {
    const spec = detectionToDecoder(d);
    addDecoder(spec.decoderId, {
      channelMap: spec.channelMap,
      options: spec.options,
    });
  }

  function dismiss() {
    detections.set(null);
  }
</script>

{#if $detections !== null}
  <section class="detect" aria-label="Detection results">
    <div class="head">
      <strong>Detected signals</strong>
      <InfoTip label="What can be detected?">
        Scans every active channel for supported protocols and detects their
        settings.
        <br /><br />
        <strong>Currently supported:</strong>
        <br /><br />
        <strong>UART</strong> — baud rate, data bits (7/8/9), parity
        (none/even/odd) and signal inversion (idle-low lines). The frame format
        is shown as data-parity-stop, e.g. <span class="mono">8-N-1</span>; stop
        bits are assumed 1, since extra stop bits look identical to idle time on
        the wire.
        <br /><br />
        <strong>I²C</strong> — finds the two-wire bus and works out which line is
        the clock (SCL) and which is data (SDA), so the decoder is wired up the right
        way round automatically.
      </InfoTip>
      <span class="grow"></span>
      <button
        class="dismiss"
        onclick={dismiss}
        aria-label="Dismiss detection results">✕</button
      >
    </div>

    {#if $detections.length === 0}
      <p class="empty">
        No supported signals detected on the active channels. Try a higher
        sample rate or capture more data — detection needs several sample points
        per bit.
      </p>
    {:else}
      <ul class="hits">
        {#each $detections as d (key(d))}
          <li class="hit">
            <div class="info">
              <div class="title">
                <span class="proto">{PROTO_NAME[d.kind]}</span>
                <span class="on">on</span>
                <span class="ch">{channelText(d)}</span>
              </div>
              <div class="params mono">
                {#if d.kind === "uart"}
                  {d.baudrate.toLocaleString()} baud &middot; {framing(d)}
                  {#if d.invert === "yes"}<span class="tag">inverted</span>{/if}
                {:else if d.kind === "i2c"}
                  {d.byteCount.toLocaleString()} bytes
                {/if}
              </div>
            </div>
            <div class="actions">
              <span class="conf" title={confTitle(d)}
                >{Math.round(d.confidence * 100)}% match</span
              >
              <button class="add" onclick={() => add(d)}>Add decoder</button>
            </div>
          </li>
        {/each}
      </ul>
    {/if}
  </section>
{/if}

<style>
  .detect {
    padding: 8px 14px;
    border-bottom: 1px solid var(--border);
    background: var(--bg-panel);
  }
  .head {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-bottom: 8px;
  }
  .grow {
    flex: 1;
  }
  .dismiss {
    display: inline-flex;
    align-items: center;
    background: none;
    border: none;
    padding: 0 2px;
    color: var(--fg-dim);
    font-size: var(--fs-ui);
  }
  .dismiss:hover,
  .dismiss:focus {
    color: var(--accent);
    border-color: transparent;
  }
  .empty {
    margin: 0;
    color: var(--fg-dim);
    font-size: var(--fs-ui);
    line-height: 1.4;
  }
  .hits {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 6px;
  }
  /* Each card hugs its content with a fixed, comfortable gap to the actions,
     rather than stretching full-width and dumping all the slack into one void.
     The info block reserves a min-width so the actions line up across cards. */
  .hit {
    display: flex;
    align-items: center;
    gap: 20px;
    padding: 8px 12px;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--bg-elev);
  }
  .info {
    min-width: 160px;
  }
  .actions {
    display: flex;
    align-items: center;
    gap: 10px;
  }
  /* Plain readable line — "UART on D0" — names protocol and channel without
     label chrome; weight/colour do the categorising. */
  .title {
    display: flex;
    align-items: baseline;
    gap: 5px;
  }
  .proto {
    font-weight: 600;
    color: var(--fg);
  }
  .on {
    color: var(--fg-dim);
  }
  .ch {
    font-weight: 600;
    color: var(--accent);
  }
  .params {
    margin-top: 3px;
    color: var(--fg-dim);
    font-size: var(--fs-ui);
  }
  .conf {
    flex: none;
    padding: 1px 6px;
    border-radius: 999px;
    background: var(--bg);
    color: var(--ok);
    font-size: var(--fs-ui);
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }
  .tag {
    margin-left: 4px;
    padding: 0 5px;
    border-radius: 4px;
    background: var(--bg);
    color: var(--warn);
    font-size: var(--fs-ui);
  }
  /* Secondary, not primary: a repeated per-row action shouldn't shout. Recessed
     against the elevated card so it still reads as a control; accent on hover. */
  .add {
    flex: none;
    background: var(--bg);
    font-size: var(--fs-ui);
    white-space: nowrap;
  }
</style>
