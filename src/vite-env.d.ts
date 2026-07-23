/// <reference types="svelte" />
/// <reference types="vite/client" />

declare module "*.fw?url" {
  const src: string;
  export default src;
}

// Build provenance injected by Vite `define` (see vite.config.ts).
declare const __GIT_COMMIT__: string;
declare const __GIT_BRANCH__: string;
