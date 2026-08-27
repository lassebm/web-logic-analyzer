// Guard against losing work to a refresh or a navigation away from the page.
// Nothing here is persisted, so a stray ⌘R discards a capture that may have
// taken minutes to record, or a serial log that can't be replayed. A
// `beforeunload` listener is the only way to intercept that — no in-app modal
// can stop a reload or an address-bar navigation. Browsers show their own fixed
// "Leave site?" wording and ignore any text we supply, so the reason strings
// below are never seen by the user; they exist so the decision is testable.
//
// An imported or demo capture is deliberately *not* guarded: that data still
// exists on disk (or is one click away), so prompting there would be nagging
// rather than protection.
import { derived, get, type Readable } from "svelte/store";
import {
  capturedSamples,
  captureStatus,
  isTabOnlyCapture,
  monitorActive,
  sampleSource,
  type CaptureStatus,
  type SampleSource,
} from "./session";
import { monitorLines } from "./monitor";

export interface UnsavedWorkState {
  captureStatus: CaptureStatus;
  sampleSource: SampleSource;
  sampleCount: number;
  monitorActive: boolean;
  monitorLineCount: number;
}

/** Why leaving would lose something, or null when there's nothing to lose. */
export function unsavedWorkReason(s: UnsavedWorkState): string | null {
  if (s.captureStatus === "running") return "A capture is still running.";
  if (s.monitorActive) return "The serial monitor is still running.";
  if (isTabOnlyCapture(s.sampleSource, s.sampleCount))
    return "This capture is only in memory — export it first to keep it.";
  if (s.monitorLineCount > 0)
    return "The serial log is only in memory — save it first to keep it.";
  return null;
}

/** `capturedSamples` counts every capture a Run took, and already tracks the
 *  mutation of a filling buffer — so a stopped run whose newest capture is empty
 *  is still guarded on the strength of the earlier ones. */
export const unsavedWork: Readable<string | null> = derived(
  [captureStatus, capturedSamples, sampleSource, monitorActive, monitorLines],
  ([$status, $samples, $source, $monitorActive, $lines]) =>
    unsavedWorkReason({
      captureStatus: $status,
      sampleSource: $source,
      sampleCount: $samples,
      monitorActive: $monitorActive,
      monitorLineCount: $lines.length,
    }),
);

export function onBeforeUnload(event: BeforeUnloadEvent): void {
  const reason = get(unsavedWork);
  if (!reason) return;
  event.preventDefault();
  // Legacy path: older Chromium/Safari only prompt when returnValue is set.
  event.returnValue = reason;
}

let registered = false;

/**
 * Attach the beforeunload guard (from the app root, on mount). Idempotent;
 * returns a teardown that detaches it again.
 */
export function registerUnloadGuard(): () => void {
  if (registered || typeof window === "undefined") return () => {};
  registered = true;
  window.addEventListener("beforeunload", onBeforeUnload);
  return () => {
    window.removeEventListener("beforeunload", onBeforeUnload);
    registered = false;
  };
}
