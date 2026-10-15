'use client';

import { useSyncExternalStore } from 'react';
import type { Effort, ProviderId } from '../providers';

/** Settings kept in this browser's localStorage. Keys never leave the browser except in chat requests to this app. */
export interface Settings {
  provider: ProviderId;
  /** Model ID per provider. */
  models: Partial<Record<ProviderId, string>>;
  /** API key per provider. */
  keys: Partial<Record<ProviderId, string>>;
  /** Base URL for the OpenAI-compatible provider. */
  baseUrl?: string;
  /** Reasoning effort per provider; unset means the provider's default. */
  efforts?: Partial<Record<ProviderId, Effort>>;
}

const STORAGE_KEY = 'db2i-web-settings';
const DEFAULTS: Settings = { provider: 'anthropic', models: {}, keys: {} };

const listeners = new Set<() => void>();
let cache: Settings | undefined;

function read(): Settings {
  if (cache) {
    return cache;
  }
  if (typeof window === 'undefined') {
    return DEFAULTS;
  }
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    cache = raw ? { ...DEFAULTS, ...(JSON.parse(raw) as Partial<Settings>) } : DEFAULTS;
  } catch {
    cache = DEFAULTS;
  }
  return cache;
}

/**
 * Change the settings and tell every component that uses them.
 *
 * @param update - New values, or a function of the current ones
 */
export function updateSettings(update: Partial<Settings> | ((current: Settings) => Partial<Settings>)): void {
  const current = read();
  const next = { ...current, ...(typeof update === 'function' ? update(current) : update) };
  cache = next;
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  for (const listener of listeners) {
    listener();
  }
}

/**
 * Remove the API key for one provider.
 *
 * @param provider - Provider whose key to forget
 */
export function forgetKey(provider: ProviderId): void {
  updateSettings((current) => {
    const keys = { ...current.keys };
    delete keys[provider];
    return { keys };
  });
}

/**
 * Start a browser that has no saved settings on the app's default provider
 * and model, so a user can chat without opening Settings. Saved settings win.
 *
 * @param defaults - DEFAULT_PROVIDER and DEFAULT_MODEL from the app, or the first provider with a server key
 */
export function applyDefaults(defaults: { provider: ProviderId; model?: string } | undefined): void {
  if (!defaults || window.localStorage.getItem(STORAGE_KEY) !== null) {
    return;
  }
  updateSettings({ provider: defaults.provider, models: defaults.model ? { [defaults.provider]: defaults.model } : {} });
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  const onStorage = (event: StorageEvent) => {
    if (event.key === STORAGE_KEY) {
      cache = undefined;
      listener();
    }
  };
  window.addEventListener('storage', onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener('storage', onStorage);
  };
}

/**
 * The current settings, updated when they change in this tab or another.
 *
 * @returns Settings
 */
export function useSettings(): Settings {
  return useSyncExternalStore(subscribe, read, () => DEFAULTS);
}

/**
 * Read the settings outside React, for example when sending a request.
 *
 * @returns Settings
 */
export function currentSettings(): Settings {
  return read();
}
