'use client';

import { useSyncExternalStore } from 'react';

/** Milliseconds each tool call took, by tool call ID, as seen by this page. */
const durations = new Map<string, number>();
const durationListeners = new Set<() => void>();

function subscribeDurations(listener: () => void): () => void {
  durationListeners.add(listener);
  return () => durationListeners.delete(listener);
}

/**
 * Remember how long a tool call took.
 *
 * @param toolCallId - The tool call
 * @param durationMs - Its duration
 */
export function setDuration(toolCallId: string, durationMs: number): void {
  durations.set(toolCallId, durationMs);
  for (const listener of durationListeners) {
    listener();
  }
}

/**
 * How long a tool call took, once its result has arrived.
 *
 * @param toolCallId - The tool call
 * @returns Milliseconds, or undefined while it runs or after a reload
 */
export function useDuration(toolCallId: string): number | undefined {
  return useSyncExternalStore(
    subscribeDurations,
    () => durations.get(toolCallId),
    () => undefined,
  );
}

let now = 0;
const clockListeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | undefined;

function subscribeClock(listener: () => void): () => void {
  clockListeners.add(listener);
  if (!timer) {
    now = Date.now();
    timer = setInterval(() => {
      now = Date.now();
      for (const each of clockListeners) {
        each();
      }
    }, 15_000);
  }
  return () => {
    clockListeners.delete(listener);
    if (clockListeners.size === 0 && timer) {
      clearInterval(timer);
      timer = undefined;
    }
  };
}

/**
 * The current time, updated every 15 seconds, for expiry countdowns.
 *
 * @returns Epoch milliseconds; 0 during server rendering
 */
export function useNow(): number {
  return useSyncExternalStore(
    subscribeClock,
    () => now || (now = Date.now()),
    () => 0,
  );
}
