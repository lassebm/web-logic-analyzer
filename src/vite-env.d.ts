/// <reference types="svelte" />
/// <reference types="vite/client" />

declare module "*.fw?url" {
  const src: string;
  export default src;
}
