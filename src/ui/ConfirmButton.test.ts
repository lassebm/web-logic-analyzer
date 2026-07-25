// @vitest-environment jsdom
import { render, screen, fireEvent } from "@testing-library/svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import ConfirmButton from "./ConfirmButton.svelte";

const props = (over: Record<string, unknown> = {}) => ({
  label: "Run",
  confirmLabel: "Confirm run?",
  onconfirm: vi.fn(),
  ...over,
});

afterEach(() => vi.useRealTimers());

const button = () => screen.getByRole("button");

describe("ConfirmButton", () => {
  it("arms on the first click and fires on the second", async () => {
    const p = props();
    render(ConfirmButton, p);

    await fireEvent.click(button());
    expect(button()).toHaveTextContent("Confirm run?");
    expect(p.onconfirm).not.toHaveBeenCalled();

    await fireEvent.click(button());
    expect(p.onconfirm).toHaveBeenCalledTimes(1);
    expect(button()).toHaveTextContent("Run"); // back to resting
  });

  it("fires on the first click when there is nothing to confirm", async () => {
    const p = props({ needsConfirm: false });
    render(ConfirmButton, p);

    await fireEvent.click(button());

    expect(p.onconfirm).toHaveBeenCalledTimes(1);
    expect(button()).toHaveTextContent("Run");
  });

  it("disarms on a click elsewhere, not on the arming click itself", async () => {
    const p = props();
    render(ConfirmButton, p);

    await fireEvent.click(button());
    expect(button()).toHaveTextContent("Confirm run?"); // survived its own click

    await fireEvent.click(document.body);
    expect(button()).toHaveTextContent("Run");
    expect(p.onconfirm).not.toHaveBeenCalled();
  });

  it("disarms on Escape", async () => {
    const p = props();
    render(ConfirmButton, p);

    await fireEvent.click(button());
    await fireEvent.keyDown(window, { key: "Escape" });

    expect(button()).toHaveTextContent("Run");
    expect(p.onconfirm).not.toHaveBeenCalled();
  });

  it("disarms itself after the timeout, so it can't fire much later", async () => {
    vi.useFakeTimers();
    const p = props({ timeoutMs: 3000 });
    render(ConfirmButton, p);

    await fireEvent.click(button());
    await vi.advanceTimersByTimeAsync(3100);

    expect(button()).toHaveTextContent("Run");
    expect(p.onconfirm).not.toHaveBeenCalled();
  });

  it("styles the armed state as destructive", async () => {
    render(ConfirmButton, props({ class: "primary" }));
    expect(button()).toHaveClass("primary");

    await fireEvent.click(button());

    expect(button()).toHaveClass("danger");
    expect(button()).not.toHaveClass("primary");
  });

  it("does nothing at all while disabled", async () => {
    const p = props({ disabled: true });
    render(ConfirmButton, p);

    await fireEvent.click(button());

    expect(button()).toBeDisabled();
    expect(button()).toHaveTextContent("Run");
    expect(p.onconfirm).not.toHaveBeenCalled();
  });
});
