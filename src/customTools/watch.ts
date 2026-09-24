/**
 * Re-read MCP_CUSTOM_TOOLS when the files change.
 *
 * A valid set replaces the registry. An invalid set is logged and the last
 * good set keeps serving.
 */

import { readdirSync, statSync, watch, type FSWatcher } from 'node:fs';
import path from 'node:path';

import { getEnabledTools } from '../config.js';
import { syncLiveCustomTools } from '../server.js';
import { notifyCustomToolsChanged } from '../transports/http.js';
import { logger } from '../utils/logger.js';
import { customToolInputs, loadCustomToolsFromEnv } from './loader.js';
import { setCustomTools } from './registry.js';

const DEFAULT_DEBOUNCE_MS = 200;

let watchers: FSWatcher[] = [];
const watchedDirs = new Set<string>();
let timer: ReturnType<typeof setTimeout> | undefined;
let debounceMs = DEFAULT_DEBOUNCE_MS;
let running = false;

export interface CustomToolsWatchOptions {
  /** Wait after the last filesystem event before reloading. Default 200ms. */
  debounceMs?: number;
}

/**
 * Watch the files and directories in MCP_CUSTOM_TOOLS.
 * Call assertCustomToolsWatch before this. A second call replaces the previous watches.
 */
export function startCustomToolsWatch(options: CustomToolsWatchOptions = {}): void {
  stopCustomToolsWatch();
  debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  running = true;

  for (const input of customToolInputs()) {
    const resolved = path.resolve(input);
    const info = statSync(resolved);
    if (info.isDirectory()) {
      watchDirectory(resolved);
    } else {
      watchPath(resolved);
    }
  }
}

/** Close every watch so the process can exit. */
export function stopCustomToolsWatch(): void {
  running = false;
  if (timer) {
    clearTimeout(timer);
    timer = undefined;
  }
  for (const watcher of watchers) {
    watcher.close();
  }
  watchers = [];
  watchedDirs.clear();
}

/**
 * Re-read the whole set. Used by the watcher and by tests.
 * Returns true when the new set replaced the registry.
 */
export function reloadCustomTools(): boolean {
  try {
    const loaded = loadCustomToolsFromEnv();
    const enabled = new Set(getEnabledTools(loaded.tools));
    setCustomTools(loaded);
    syncLiveCustomTools(loaded, enabled);
    notifyCustomToolsChanged();
    logger.info(
      { tools: loaded.tools.length, annotations: loaded.annotations.length },
      'Custom tools reloaded',
    );
    return true;
  } catch (error) {
    logger.error({ err: error }, 'Custom tools reload rejected; keeping the last good set');
    return false;
  }
}

function watchDirectory(dir: string): void {
  if (watchedDirs.has(dir)) {
    return;
  }
  watchedDirs.add(dir);
  watchPath(dir);
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || !entry.isDirectory()) {
      continue;
    }
    watchDirectory(path.join(dir, entry.name));
  }
}

function watchPath(target: string): void {
  let watcher: FSWatcher;
  try {
    watcher = watch(target, () => {
      if (statSync(target, { throwIfNoEntry: false })?.isDirectory()) {
        watchDirectory(target);
      }
      scheduleReload();
    });
  } catch (error) {
    logger.error({ err: error, path: target }, 'Could not watch custom tools path');
    return;
  }
  watcher.on('error', (error) => {
    logger.error({ err: error, path: target }, 'Custom tools watch failed');
  });
  watchers.push(watcher);
}

function scheduleReload(): void {
  if (!running) {
    return;
  }
  if (timer) {
    clearTimeout(timer);
  }
  timer = setTimeout(() => {
    timer = undefined;
    if (running) {
      reloadCustomTools();
    }
  }, debounceMs);
}
