import "@testing-library/jest-dom/vitest";

// jsdom lacks ResizeObserver, which some components use on mount.
if (!("ResizeObserver" in globalThis)) {
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver =
    class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    };
}
