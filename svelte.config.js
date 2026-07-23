import { vitePreprocess } from "@sveltejs/vite-plugin-svelte";

export default {
  preprocess: vitePreprocess(),
  // Enforce Svelte 5 runes mode across the project — no implicit legacy fallback.
  compilerOptions: {
    runes: true,
  },
};
