// @vitest-environment jsdom
import { render, fireEvent, waitFor, screen } from "@testing-library/svelte";
import { get } from "svelte/store";
import { beforeEach, describe, expect, it } from "vitest";
import ImportMenu from "./ImportMenu.svelte";
import { captureBuffer, captureStatus, config } from "../stores/session";
import { defaultConfig } from "../test/fixtures";

beforeEach(() => {
  captureBuffer.set(null);
  captureStatus.set("idle");
  config.set(defaultConfig());
});

describe("ImportMenu", () => {
  it("imports a CSV file into the capture buffer", async () => {
    const { container } = render(ImportMenu);
    const input = container.querySelector(
      'input[type="file"]',
    ) as HTMLInputElement;

    const csv = "sample,time_s,D0\n0,0.000000e+0,1\n1,1.000000e-6,0\n";
    const file = new File([csv], "capture.csv", { type: "text/csv" });
    Object.defineProperty(input, "files", { value: [file] });
    await fireEvent.change(input);

    await waitFor(() => expect(get(captureBuffer)?.sampleCount).toBe(2));
    expect(get(captureBuffer)?.sampleRate).toBe(1_000_000);
    expect(get(captureStatus)).toBe("done");
  });

  it("shows an error for an unrecognized file", async () => {
    const { container } = render(ImportMenu);
    const input = container.querySelector(
      'input[type="file"]',
    ) as HTMLInputElement;

    const file = new File(["not a capture"], "notes.txt", {
      type: "text/plain",
    });
    Object.defineProperty(input, "files", { value: [file] });
    await fireEvent.change(input);

    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(/unrecognized/i),
    );
    expect(get(captureBuffer)).toBeNull();
  });
});
