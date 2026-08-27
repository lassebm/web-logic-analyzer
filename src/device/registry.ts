// The backends the app can talk to, in the order the device-bar selector lists
// them. Mirrors decode/registry.ts: adding hardware support means adding a row
// here and nothing else.

import { fx2Backend } from "./fx2";
import { sumpBackend } from "./sump";
import type { BackendId, DeviceBackend } from "./types";

export const BACKENDS: DeviceBackend[] = [fx2Backend, sumpBackend];

export const DEFAULT_BACKEND_ID: BackendId = "fx2";

export function getBackend(id: BackendId): DeviceBackend {
  return BACKENDS.find((b) => b.id === id) ?? BACKENDS[0];
}

/** True for an id we still ship a backend for (a stale localStorage value). */
export function isBackendId(value: unknown): value is BackendId {
  return BACKENDS.some((b) => b.id === value);
}
