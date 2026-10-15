'use client';

import { useEffect, useSyncExternalStore } from 'react';
import type { ToolSummary } from '../catalog';

/** The server's tool list for the signed-in user, loaded once and shared by every page. */
export interface CatalogState {
  status: 'idle' | 'loading' | 'ready' | 'error';
  tools: ToolSummary[];
  error?: string;
  /** True when the server answered that the browser must sign in again. */
  signIn?: boolean;
}

const IDLE: CatalogState = { status: 'idle', tools: [] };
let state: CatalogState = IDLE;
const listeners = new Set<() => void>();

function set(next: CatalogState): void {
  state = next;
  for (const listener of listeners) {
    listener();
  }
}

/**
 * Fetch the tool list. Calls while a fetch runs share it.
 *
 * @param force - Fetch again even when the list is loaded
 */
export async function loadCatalog(force = false): Promise<void> {
  if (state.status === 'loading' || (state.status === 'ready' && !force)) {
    return;
  }
  set({ ...state, status: 'loading', error: undefined });
  try {
    const response = await fetch('/api/tools', { cache: 'no-store' });
    const body = (await response.json()) as { tools?: ToolSummary[]; error?: string; signIn?: boolean };
    if (!response.ok) {
      set({ ...IDLE, status: 'error', error: body.error ?? 'Could not load the tools.', signIn: body.signIn });
      return;
    }
    set({ status: 'ready', tools: body.tools ?? [] });
  } catch (error) {
    set({ ...IDLE, status: 'error', error: error instanceof Error ? error.message : 'Could not load the tools.' });
  }
}

/** Forget the tool list, for example after signing out. */
export function resetCatalog(): void {
  set(IDLE);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * The tool list, loaded when the browser is signed in.
 *
 * @param signedIn - Whether to load it
 * @returns The current state
 */
export function useCatalog(signedIn: boolean): CatalogState {
  const current = useSyncExternalStore(subscribe, () => state, () => IDLE);
  useEffect(() => {
    if (signedIn) {
      void loadCatalog();
    } else {
      resetCatalog();
    }
  }, [signedIn]);
  return current;
}
