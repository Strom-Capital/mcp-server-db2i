'use client';

import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import { useCallback, useEffect, useState } from 'react';
import type { ChatRecord } from '../chats';
import type { ExportFile } from '../results';

/** An export_query file, with the time it was created. */
export interface ExportEntry extends ExportFile {
  at: number;
  tool: string;
  sql?: string;
  /** The tool arguments, so the export can be made again once the link expires. */
  input?: Record<string, unknown>;
}

interface AppDb extends DBSchema {
  chats: { key: string; value: ChatRecord; indexes: { updatedAt: number } };
  exports: { key: string; value: ExportEntry; indexes: { at: number } };
}

const CHAT_LIMIT = 500;
const changeListeners = new Set<() => void>();
let dbPromise: Promise<IDBPDatabase<AppDb>> | undefined;

function db(): Promise<IDBPDatabase<AppDb>> {
  dbPromise ??= openDB<AppDb>('db2i-web-app', 2, {
    upgrade(database, oldVersion) {
      if (oldVersion < 1) {
        database.createObjectStore('exports', { keyPath: 'url' }).createIndex('at', 'at');
      }
      if (oldVersion < 2) {
        // Version 1 kept a query history, which saved chats replace
        const untyped = database as unknown as IDBPDatabase;
        if (untyped.objectStoreNames.contains('history')) {
          untyped.deleteObjectStore('history');
        }
        database.createObjectStore('chats', { keyPath: 'id' }).createIndex('updatedAt', 'updatedAt');
      }
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
 * Save a chat, keeping at most the newest CHAT_LIMIT.
 *
 * @param chat - The chat; an existing ID is replaced
 */
export async function saveChat(chat: ChatRecord): Promise<void> {
  const database = await db();
  await database.put('chats', chat);
  const count = await database.count('chats');
  if (count > CHAT_LIMIT) {
    const oldest = await database.getAllKeysFromIndex('chats', 'updatedAt', null, count - CHAT_LIMIT);
    const tx = database.transaction('chats', 'readwrite');
    await Promise.all([...oldest.map((key) => tx.store.delete(key)), tx.done]);
  }
  changed();
}

/**
 * Read one saved chat.
 *
 * @param id - The chat ID
 * @returns The chat, or undefined when there is none
 */
export async function loadChat(id: string): Promise<ChatRecord | undefined> {
  return (await db()).get('chats', id);
}

/**
 * Delete a saved chat.
 *
 * @param id - The chat ID
 */
export async function deleteChat(id: string): Promise<void> {
  await (await db()).delete('chats', id);
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

const loadChats = async () => (await (await db()).getAllFromIndex('chats', 'updatedAt')).reverse();
const loadExports = async () => (await (await db()).getAllFromIndex('exports', 'at')).reverse();

/**
 * Saved chats, newest first, updated when one is saved or deleted.
 *
 * @returns The chats and a loading flag
 */
export function useChats() {
  return useStore<ChatRecord[]>(loadChats, []);
}

/**
 * Export files, newest first, updated when one is added.
 *
 * @returns The entries and a loading flag
 */
export function useExports() {
  return useStore<ExportEntry[]>(loadExports, []);
}
