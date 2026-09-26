/**
 * Export files on the MCP host.
 *
 * Every export gets a 256-bit random id. The id names the file in EXPORT_DIR
 * and, in HTTP mode, is the whole download link: the registry below is the
 * only way from an id to a file, so an id that is not in it leads nowhere,
 * and a request can never name a path. Entries expire after
 * EXPORT_TTL_MINUTES, and a link is removed from the registry the moment its
 * last allowed download (EXPORT_MAX_DOWNLOADS) starts.
 *
 * The registry lives in memory. After a restart the old files are orphans, so
 * startup deletes them.
 */

import { randomBytes } from 'node:crypto';
import { chmod, lstat, mkdir, readdir, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { getExportConfig, type ExportConfig } from '../config.js';
import { createChildLogger } from '../utils/logger.js';

const log = createChildLogger({ component: 'export-store' });

export type ExportFormat = 'csv' | 'xlsx';

/** An export id: 32 random bytes in base64url. */
export const EXPORT_ID_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/** Files this store writes. Nothing else in EXPORT_DIR is touched. */
const EXPORT_FILE_PATTERN = /^[A-Za-z0-9_-]{43}\.(csv|xlsx)(\.part)?$/;

const SWEEP_INTERVAL_MS = 60_000;

export const EXPORT_CONTENT_TYPES: Record<ExportFormat, string> = {
  csv: 'text/csv; charset=utf-8',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

export interface ExportEntry {
  id: string;
  /** File on disk. */
  path: string;
  /** Name the user's download is saved as. */
  filename: string;
  format: ExportFormat;
  /** Who ran the export: `stdio`, or the IBM i user profile. */
  owner: string;
  bytes: number;
  rows: number;
  /** Epoch milliseconds. */
  expiresAt: number;
  /** Downloads started so far. */
  downloads: number;
}

/** An export that has started and not finished. */
export interface ExportSlot {
  id: string;
  /** Written while the export runs. */
  partPath: string;
  /** Renamed to on success. */
  finalPath: string;
  /** Rename the finished file and register it. */
  complete(entry: Omit<ExportEntry, 'id' | 'path' | 'expiresAt' | 'downloads'>): Promise<ExportEntry>;
  /** Give the slot back. Deletes the part file if it is still there. Never throws. */
  release(): Promise<void>;
}

/** An export was refused because a limit is reached. */
export class ExportLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExportLimitError';
  }
}

let config: ExportConfig | undefined;
let sweeper: NodeJS.Timeout | undefined;
const entries = new Map<string, ExportEntry>();
let running = 0;
let reservedBytes = 0;

/**
 * Create EXPORT_DIR with mode 0700, check it is a real directory owned by this
 * user, delete files left by an earlier run, and start the expiry sweep.
 * Does nothing when exports are off.
 *
 * @throws Error when the directory cannot be used safely
 */
export async function initExportStore(): Promise<void> {
  const current = getExportConfig();
  if (!current) {
    return;
  }
  await mkdir(current.dir, { recursive: true, mode: 0o700 });
  const stats = await lstat(current.dir);
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new Error('EXPORT_DIR must be a directory, not a symbolic link or a file');
  }
  const uid = process.getuid?.();
  if (uid !== undefined && stats.uid !== uid) {
    throw new Error('EXPORT_DIR must be owned by the user the server runs as');
  }
  if ((stats.mode & 0o077) !== 0) {
    await chmod(current.dir, 0o700);
    log.warn('EXPORT_DIR was readable by other users; its mode is now 0700');
  }

  let removed = 0;
  for (const name of await readdir(current.dir)) {
    if (EXPORT_FILE_PATTERN.test(name)) {
      await unlink(join(current.dir, name)).catch(() => undefined);
      removed += 1;
    }
  }
  if (removed > 0) {
    log.info({ removed }, 'Deleted export files left by an earlier run');
  }

  config = current;
  sweeper = setInterval(() => {
    void sweepExpired();
  }, SWEEP_INTERVAL_MS);
  sweeper.unref();
  log.info({ ttlMinutes: current.ttlMinutes, maxDownloads: current.maxDownloads }, 'Query exports enabled');
}

/**
 * Stop the sweep and delete every export file. Links end with the process
 * anyway, since the registry is in memory.
 */
export async function closeExportStore(): Promise<void> {
  if (sweeper) {
    clearInterval(sweeper);
    sweeper = undefined;
  }
  const all = [...entries.values()];
  entries.clear();
  await Promise.all(all.map((entry) => unlink(entry.path).catch(() => undefined)));
  config = undefined;
  running = 0;
  reservedBytes = 0;
}

/** True once initExportStore has prepared the directory. */
export function isExportStoreReady(): boolean {
  return config !== undefined;
}

function storedBytes(): number {
  let total = 0;
  for (const entry of entries.values()) {
    total += entry.bytes;
  }
  return total;
}

/**
 * Reserve a slot for a new export, within EXPORT_MAX_CONCURRENT and
 * EXPORT_DIR_MAX_BYTES. Each running export reserves EXPORT_MAX_BYTES, so
 * exports that run at the same time cannot fill the disk between them.
 *
 * @throws ExportLimitError when a limit is reached
 */
export function beginExport(format: ExportFormat): ExportSlot {
  if (!config) {
    throw new Error('Query exports are not enabled');
  }
  const settings = config;
  if (running >= settings.maxConcurrent) {
    throw new ExportLimitError(
      `${settings.maxConcurrent} exports are already running (EXPORT_MAX_CONCURRENT). Try again when one has finished.`
    );
  }
  if (storedBytes() + reservedBytes + settings.maxBytes > settings.dirMaxBytes) {
    throw new ExportLimitError(
      'The export directory is full (EXPORT_DIR_MAX_BYTES). Try again when earlier downloads have expired.'
    );
  }

  running += 1;
  reservedBytes += settings.maxBytes;
  const id = randomBytes(32).toString('base64url');
  const finalPath = join(settings.dir, `${id}.${format}`);
  const partPath = `${finalPath}.part`;
  let released = false;

  return {
    id,
    partPath,
    finalPath,
    async complete(details) {
      await rename(partPath, finalPath);
      const entry: ExportEntry = {
        ...details,
        id,
        path: finalPath,
        expiresAt: Date.now() + settings.ttlMinutes * 60_000,
        downloads: 0,
      };
      entries.set(id, entry);
      return entry;
    },
    async release() {
      if (released) {
        return;
      }
      released = true;
      running -= 1;
      reservedBytes -= settings.maxBytes;
      await unlink(partPath).catch(() => undefined);
    },
  };
}

/**
 * Find a live export without using it up. For HEAD requests and link checks.
 */
export function peekExport(id: string): ExportEntry | undefined {
  if (!EXPORT_ID_PATTERN.test(id)) {
    return undefined;
  }
  const entry = entries.get(id);
  if (!entry || entry.expiresAt <= Date.now()) {
    return undefined;
  }
  return entry;
}

/**
 * Take an export for download and count it against EXPORT_MAX_DOWNLOADS. The
 * count is taken synchronously, so requests racing for the same link can never
 * get more downloads than allowed. The last allowed download removes the link
 * from the registry, and its caller deletes the file once that download ends.
 *
 * @returns The export, and whether the caller must delete the file afterwards
 */
export function takeExport(id: string): { entry: ExportEntry; deleteAfter: boolean } | undefined {
  const entry = peekExport(id);
  if (!entry || !config) {
    return undefined;
  }
  entry.downloads += 1;
  if (entry.downloads >= config.maxDownloads) {
    entries.delete(id);
    return { entry, deleteAfter: true };
  }
  return { entry, deleteAfter: false };
}

/** Delete an export file. Never throws. */
export async function deleteExportFile(entry: ExportEntry): Promise<void> {
  await unlink(entry.path).catch(() => undefined);
}

/** Remove expired exports and their files. */
export async function sweepExpired(now = Date.now()): Promise<number> {
  const expired = [...entries.values()].filter((entry) => entry.expiresAt <= now);
  for (const entry of expired) {
    entries.delete(entry.id);
  }
  await Promise.all(expired.map((entry) => deleteExportFile(entry)));
  if (expired.length > 0) {
    log.debug({ removed: expired.length }, 'Expired export files deleted');
  }
  return expired.length;
}
