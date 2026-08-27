// The loaded custom-firmware descriptor, as a store.
//
// It lives here rather than in stores/session.ts because the FX2 backend
// (device/fx2.ts) is what actually consumes it during a connect, and session
// imports the backend registry — putting the store in session would close that
// loop. session re-exports it, so the UI still gets everything from one module.

import { writable } from "svelte/store";
import { loadFirmware, type StoredFirmware } from "./firmwareStore";

export const firmwareInfo = writable<StoredFirmware | null>(null);

/** Re-read the stored custom firmware (IndexedDB) into the store. */
export async function refreshFirmware(): Promise<void> {
  firmwareInfo.set(await loadFirmware());
}
