/// <reference types="vitest/config" />
import { execSync } from "node:child_process";
import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";

// Resolve build provenance from git at config time. Wrapped so a build without
// git (e.g. from a source tarball) degrades gracefully instead of failing.
function git(cmd: string, fallback: string): string {
  try {
    return execSync(`git ${cmd}`, { stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim();
  } catch {
    return fallback;
  }
}
const gitCommit = git("rev-parse --short HEAD", "unknown");
// CI checks out a detached HEAD, where `git branch` reports "HEAD"; prefer the
// ref name the (GitHub Actions) workflow exports, and fall back to the local
// branch for dev builds.
const gitBranch =
  process.env.GITHUB_REF_NAME ?? git("rev-parse --abbrev-ref HEAD", "unknown");

// WebUSB requires a secure context; localhost counts as secure for dev.
export default defineConfig({
  // Relative base so the built app works at any path — locally via `preview`
  // and under the GitHub Pages project sub-path (/web-logic-analyzer/) alike,
  // without hardcoding the repo name. The app has no router/absolute asset refs.
  base: "./",
  plugins: [svelte()],
  assetsInclude: ["**/*.fw"], // bundle firmware binaries as assets
  define: {
    __GIT_COMMIT__: JSON.stringify(gitCommit),
    __GIT_BRANCH__: JSON.stringify(gitBranch),
  },
  server: {
    host: "127.0.0.1",
    port: 5173,
  },
  // Under Vitest, resolve Svelte's browser build so components mount client-side
  // (jsdom) instead of server-rendering. No effect on the production build.
  resolve: process.env.VITEST ? { conditions: ["browser"] } : {},
  test: {
    globals: true,
    environment: "node", // UI tests opt into jsdom via a `@vitest-environment jsdom` docblock
    include: ["src/**/*.test.ts"],
    setupFiles: ["./src/test/setup.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      include: ["src/**/*.{ts,svelte}"],
      exclude: [
        "src/**/*.test.ts",
        "src/**/*.d.ts",
        "src/main.ts",
        "src/test/**",
      ],
    },
  },
});
