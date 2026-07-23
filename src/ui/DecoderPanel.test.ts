// @vitest-environment jsdom
import { render, screen, fireEvent } from "@testing-library/svelte";
import { get } from "svelte/store";
import { tick } from "svelte";
import { beforeEach, describe, expect, it } from "vitest";
import DecoderPanel from "./DecoderPanel.svelte";
import { decoders, captureBuffer } from "../stores/session";

beforeEach(() => {
  decoders.set([]);
  captureBuffer.set(null);
});

describe("DecoderPanel", () => {
  it("adds a decoder by opening the list and picking one", async () => {
    render(DecoderPanel);
    await fireEvent.click(screen.getByRole("button", { name: /Add decoder/ }));
    // Each list row shows the decoder name plus its description.
    await fireEvent.click(screen.getByRole("button", { name: /UART/ }));
    expect(get(decoders).length).toBe(1);
    expect(get(decoders)[0].decoderId).toBe("uart");
  });

  it("explains what annotations are (tip content present in the DOM)", async () => {
    decoders.set([
      {
        uid: "d1",
        decoderId: "uart",
        label: "UART 1",
        channelMap: [0],
        options: {},
        annotations: [],
      },
    ]);
    render(DecoderPanel);
    await tick();
    expect(screen.getByText(/decoded results/i)).toBeInTheDocument();
    expect(screen.getByText(/0 annotations/)).toBeInTheDocument();
  });

  it("tells a stacked decoder its source is missing and lists compatible ones", async () => {
    // ASCII consumes 'byte' packets; with no byte-emitting instance present,
    // the Source dropdown must be replaced by a hint naming compatible decoders.
    decoders.set([
      {
        uid: "a1",
        decoderId: "ascii",
        label: "ASCII text 1",
        channelMap: [],
        options: {},
        annotations: [],
      },
    ]);
    render(DecoderPanel);
    await tick();
    const hint = screen.getByText(/Needs a source that emits byte data/i);
    expect(hint).toBeInTheDocument();
    expect(hint.textContent).toMatch(/UART/);
  });

  it("removes a decoder instance", async () => {
    decoders.set([
      {
        uid: "d1",
        decoderId: "uart",
        label: "UART 1",
        channelMap: [0],
        options: {},
        annotations: [],
      },
    ]);
    render(DecoderPanel);
    await fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    expect(get(decoders).length).toBe(0);
  });

  it("reorders decoders with the grip handle's arrow keys", async () => {
    decoders.set([
      {
        uid: "d1",
        decoderId: "uart",
        label: "UART 1",
        channelMap: [0],
        options: {},
        annotations: [],
      },
      {
        uid: "d2",
        decoderId: "uart",
        label: "UART 2",
        channelMap: [1],
        options: {},
        annotations: [],
      },
    ]);
    render(DecoderPanel);
    await tick();

    const handles = screen.getAllByLabelText(/Reorder decoder/);
    // Move the second decoder up past the first.
    await fireEvent.keyDown(handles[1], { key: "ArrowUp" });
    expect(get(decoders).map((d) => d.uid)).toEqual(["d2", "d1"]);

    // And back down again (handles re-query after the reorder).
    const after = screen.getAllByLabelText(/Reorder decoder/);
    await fireEvent.keyDown(after[0], { key: "ArrowDown" });
    expect(get(decoders).map((d) => d.uid)).toEqual(["d1", "d2"]);
  });

  it("renders baud rate as a preset dropdown that also takes a custom value", async () => {
    render(DecoderPanel);
    await fireEvent.click(screen.getByRole("button", { name: /Add decoder/ }));
    await fireEvent.click(screen.getByRole("button", { name: /UART/ }));

    const baud = screen.getByLabelText("Baud rate") as HTMLSelectElement;
    expect(baud.tagName).toBe("SELECT"); // native select: consistent arrow, no spinners
    // Every preset is listed (plus a "Custom…" entry), regardless of the value.
    expect(baud.querySelectorAll("option").length).toBeGreaterThan(8);

    // Picking a preset updates the option.
    await fireEvent.change(baud, { target: { value: "57600" } });
    expect(get(decoders)[0].options.baudrate).toBe(57600);

    // "Custom…" reveals a text field; typing an arbitrary baud commits it.
    const sel = screen.getByLabelText("Baud rate") as HTMLSelectElement;
    const customValue = [...sel.options].find(
      (o) => o.text === "Custom…",
    )!.value;
    await fireEvent.change(sel, { target: { value: customValue } });
    await tick();
    const input = screen.getByLabelText("Baud rate") as HTMLInputElement;
    expect(input.tagName).toBe("INPUT");
    await fireEvent.change(input, { target: { value: "250000" } });
    await fireEvent.blur(input);
    expect(get(decoders)[0].options.baudrate).toBe(250000);
  });

  it("auto-numbers instances of the same type and lets them be renamed", async () => {
    render(DecoderPanel);
    await fireEvent.click(screen.getByRole("button", { name: /Add decoder/ }));
    await fireEvent.click(screen.getByRole("button", { name: /UART/ }));
    await fireEvent.click(screen.getByRole("button", { name: /Add decoder/ }));
    await fireEvent.click(screen.getByRole("button", { name: /UART/ }));
    expect(get(decoders).map((d) => d.label)).toEqual(["UART 1", "UART 2"]);

    const nameInput = screen.getAllByLabelText(
      "Decoder name",
    )[0] as HTMLInputElement;
    await fireEvent.change(nameInput, { target: { value: "TX line" } });
    expect(get(decoders)[0].label).toBe("TX line");
  });
});
