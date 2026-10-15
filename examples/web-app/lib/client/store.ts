'use client';

import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import { useCallback, useEffect, useState } from 'react';
import type { ExportFile } from '../results';

/** One tool call that ran. Result rows are not kept; "run again" fetches them fresh. */
export interface HistoryEntry {
  /** The tool call ID, or a random ID for a direct run. */
  id: string;
  at: number;
  tool: string;
  input: Record<string, unknown>;
  ok: boolean;
  rowCount?: number;
  truncated?: boolean;
  durationMs?: number;
  error?: string;
  source: 'chat' | 'direct';
}

/** An export_query file, with the time it was created. */
export interface ExportEntry extends ExportFile {
  at: number;
  tool: string;
  sql?: string;
  /** The tool arguments, so the export can be made again once the link expires. */
  input?: Record<string, unknown>;
}

interface AppDb extends DBSchema {
  history: { key: string; value: HistoryEntry; indexes: { at: number } };
  exports: { key: string; value: ExportEntry; indexes: { at: number } };
}

const HISTORY_LIMIT = 1000;
const changeListeners = new Set<() => void>();
let dbPromise: Promise<IDBPDatabase<AppDb>> | undefined;

function db(): Promise<IDBPDatabase<AppDb>> {
  dbPromise ??= openDB<AppDb>('db2i-web-app', 1, {
    upgrade(database) {
      database.createObjectStore('history', { keyPath: 'id' }).createIndex('at', 'at');
      database.createObjectStore('exports', { keyPath: 'url' }).createIndex('at', 'at');
    },
  });
  return dbPromise;
}

function changed(): void {
  for (const listener of changeListeners) {
    listener();
  }
}

/**
 * Save a history entry, keeping at most the newest HISTORY_LIMIT.
 *
 * @param entry - The entry; an existing ID is replaced
 */
export async function addHistory(entry: HistoryEntry): Promise<void> {
  const database = await db();
  await database.put('history', entry);
  const count = await database.count('history');
  if (count > HISTORY_LIMIT) {
    const oldest = await database.getAllKeysFromIndex('history', 'at', null, count - HISTORY_LIMIT);
    const tx = database.transaction('history', 'readwrite');
    await Promise.all([...oldest.map((key) => tx.store.delete(key)), tx.done]);
  }
  changed();
}

/**
 * Save an export file.
 *
 * @param entry - The export; the same URL is replaced
 */
export async function addExport(entry: ExportEntry): Promise<void> {
  await (await db()).put('exports', entry);
  changed();
}

/** Delete every history entry. */
export async function clearHistory(): Promise<void> {
  await (await db()).clear('history');
  changed();
}

/** Delete every export entry whose link has expired. */
export async function clearExpiredExports(): Promise<void> {
  const database = await db();
  const now = Date.now();
  for (const entry of await database.getAll('exports')) {
    if (entry.expiresAt && Date.parse(entry.expiresAt) < now) {
      await database.delete('exports', entry.url);
    }
  }
  changed();
}

function useStore<T>(load: () => Promise<T>, initial: T): { items: T; loading: boolean; reload: () => void } {
  const [items, setItems] = useState(initial);
  const [loading, setLoading] = useState(true);
  const reload = useCallback(() => {
    load()
      .then(setItems)
      .catch(() => undefined)
      .finally(() => setLoading(false));
  }, [load]);
  useEffect(() => {
    reload();
    changeListeners.add(reload);
    return () => {
      changeListeners.delete(reload);
    };
  }, [reload]);
  return { items, loading, reload };
}

const loadHistory = async () => (await (await db()).getAllFromIndex('history', 'at')).reverse();
const loadExports = async () => (await (await db()).getAllFromIndex('exports', 'at')).reverse();

/**
 * History entries, newest first, updated when one is added.
 *
 * @returns The entries and a loading flag
 */
export function useHistory() {
  return useStore<HistoryEntry[]>(loadHistory, []);
}

/**
 * Export files, newest first, updated when one is added.
 *
 * @returns The entries and a loading flag
 */
export function useExports() {
  return useStore<ExportEntry[]>(loadExports, []);
}
