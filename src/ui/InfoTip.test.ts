// @vitest-environment jsdom
import { render, screen } from "@testing-library/svelte";
import { describe, expect, it } from "vitest";
import InfoTip from "./InfoTip.svelte";

describe("InfoTip", () => {
  it("exposes an accessible trigger button named by the label", () => {
    render(InfoTip, { props: { label: "How the trigger works" } });
    expect(
      screen.getByRole("button", { name: "How the trigger works" }),
    ).toBeInTheDocument();
  });

  it("renders a tooltip popover sized by the width prop", () => {
    const { container } = render(InfoTip, {
      props: { label: "x", width: 260 },
    });
    const pop = container.querySelector('[role="tooltip"]') as HTMLElement;
    expect(pop).not.toBeNull();
    expect(pop.style.width).toBe("260px");
  });
});
