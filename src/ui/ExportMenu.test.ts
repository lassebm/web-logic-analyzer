// @vitest-environment jsdom
import { render, screen, fireEvent, waitFor } from "@testing-library/svelte";
import { beforeEach, describe, expect, it, vi } from "vitest";
import ExportMenu from "./ExportMenu.svelte";
import { captureBuffer, config } from "../stores/session";
import { CaptureBuffer } from "../model/capture";
import { defaultConfig } from "../test/fixtures";

beforeEach(() => {
  captureBuffer.set(null);
  config.set(defaultConfig());
});

describe("ExportMenu", () => {
  it("disables export buttons without a capture", () => {
    render(ExportMenu);
    expect(screen.getByRole("button", { name: "CSV" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "VCD" })).toBeDisabled();
  });

  it("exports a CSV blob when clicked", async () => {
    const buf = new CaptureBuffer(1_000_000, 8);
    buf.append(new Uint8Array([0b01, 0b10]));
    captureBuffer.set(buf);

    // jsdom implements neither URL.createObjectURL nor anchor navigation; stub them.
    const createURL = vi.fn().mockReturnValue("blob:test");
    (URL as unknown as { createObjectURL: unknown }).createObjectURL =
      createURL;
    (URL as unknown as { revokeObjectURL: unknown }).revokeObjectURL = vi.fn();
    const click = vi.fn();
    HTMLAnchorElement.prototype.click = click;

    render(ExportMenu);
    await fireEvent.click(screen.getByRole("button", { name: "CSV" }));

    // The export is async (chunked + yields to the event loop); wait for it.
    await waitFor(() => expect(click).toHaveBeenCalledOnce());
    expect(createURL).toHaveBeenCalledOnce();
    const blob = createURL.mock.calls[0][0] as Blob;
    expect(blob.type).toContain("csv");
  });

  it("surfaces an error instead of failing silently", async () => {
    const buf = new CaptureBuffer(1_000_000, 8);
    buf.append(new Uint8Array([0b01, 0b10]));
    captureBuffer.set(buf);

    // Make the download throw during the export.
    (URL as unknown as { createObjectURL: unknown }).createObjectURL = vi
      .fn()
      .mockImplementation(() => {
        throw new Error("boom");
      });

    render(ExportMenu);
    await fireEvent.click(screen.getByRole("button", { name: "CSV" }));

    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(/boom/),
    );
    // Buttons are usable again (not stuck busy).
    expect(screen.getByRole("button", { name: "CSV" })).not.toBeDisabled();
  });
});
