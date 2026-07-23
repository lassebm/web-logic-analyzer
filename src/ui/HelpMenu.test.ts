// @vitest-environment jsdom
import { render, screen, fireEvent } from "@testing-library/svelte";
import { get } from "svelte/store";
import { beforeEach, describe, expect, it } from "vitest";
import HelpMenu from "./HelpMenu.svelte";
import { captureBuffer, decoders, monitorActive } from "../stores/session";

beforeEach(() => {
  captureBuffer.set(null);
  decoders.set([]);
  monitorActive.set(false);
});

describe("HelpMenu", () => {
  it("keeps the popover closed until the button is clicked", async () => {
    render(HelpMenu);
    expect(screen.queryByText("Load demo capture")).toBeNull();
    await fireEvent.click(
      screen.getByRole("button", { name: "Help and demo" }),
    );
    expect(screen.getByText("Load demo capture")).toBeInTheDocument();
  });

  it("Load demo capture loads the demo and adds the decoders", async () => {
    render(HelpMenu);
    await fireEvent.click(
      screen.getByRole("button", { name: "Help and demo" }),
    );
    await fireEvent.click(
      screen.getByRole("button", { name: "Load demo capture" }),
    );
    expect(get(captureBuffer)?.sampleCount ?? 0).toBeGreaterThan(0);
    expect(get(decoders).length).toBeGreaterThan(0);
  });

  it("shows the build commit linking to the GitHub commit", async () => {
    render(HelpMenu);
    await fireEvent.click(
      screen.getByRole("button", { name: "Help and demo" }),
    );
    // __GIT_COMMIT__ is injected by Vite `define` (real short hash in tests).
    const link = screen.getByRole("link", { name: __GIT_COMMIT__ });
    expect(link).toHaveAttribute(
      "href",
      expect.stringContaining(`/commit/${__GIT_COMMIT__}`),
    );
  });
});
