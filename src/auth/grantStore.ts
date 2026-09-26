/**
 * Store for OAuth refresh grants.
 *
 * Grants are always held in memory. With MCP_OAUTH_STATE_FILE set, every
 * change is also written to that file, so users stay signed in across a
 * restart. A grant carries the user's IBM i password, so each entry is
 * encrypted with AES-256-GCM under a key derived from MCP_OAUTH_SECRET.
 * Entries are keyed by a hash of the refresh token; the token itself is
 * never written.
 */

import crypto from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import type { DB2iConfig } from '../config.js';
import { createChildLogger } from '../utils/logger.js';

const log = createChildLogger({ component: 'oauth-store' });

const FILE_VERSION = 1;
const KEY_INFO = 'oauth-grant-store';
const KEY_CHECK = 'oauth-grant-store-key-check';

/** A refresh token's grant: who signed in, on which system, for which client. */
export interface RefreshGrant {
  clientId: string;
  grantId: string;
  /** Owner of the grant: one user profile on one system. */
  user: string;
  system: string;
  config: DB2iConfig;
  expiresAt: number;
}

/** What a stored grant keeps. The connection is rebuilt from the current profiles on load. */
export interface StoredGrant {
  clientId: string;
  grantId: string;
  system: string;
  username: string;
  password: string;
  expiresAt: number;
}

/** One encrypted entry in the state file. */
export interface EncryptedEntry {
  id: string;
  iv: string;
  tag: string;
  data: string;
}

interface StateFile {
  version: number;
  keyCheck: string;
  grants: EncryptedEntry[];
}

/**
 * Turn a stored grant back into a live one. Returns undefined when the grant
 * can no longer be used, for example because its system was removed.
 */
export type GrantRestorer = (stored: StoredGrant) => RefreshGrant | undefined;

/** The store key for a refresh token: its SHA-256, so the token itself is never kept. */
export function grantKey(refreshToken: string): string {
  return crypto.createHash('sha256').update(refreshToken).digest('base64url');
}

/** Derive the encryption key from MCP_OAUTH_SECRET, apart from its signing use. */
export function deriveStoreKey(secret: Buffer): Buffer {
  return Buffer.from(crypto.hkdfSync('sha256', secret, Buffer.alloc(0), KEY_INFO, 32));
}

function keyCheckFor(key: Buffer): string {
  return crypto.createHmac('sha256', key).update(KEY_CHECK).digest('base64url');
}

/** Encrypt a grant. The entry ID is authenticated, so an entry cannot be moved to another ID. */
export function encryptEntry(key: Buffer, id: string, grant: StoredGrant): EncryptedEntry {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(id, 'utf8'));
  const data = Buffer.concat([cipher.update(JSON.stringify(grant), 'utf8'), cipher.final()]);
  return {
    id,
    iv: iv.toString('base64url'),
    tag: cipher.getAuthTag().toString('base64url'),
    data: data.toString('base64url'),
  };
}

/** Decrypt an entry, or undefined when it was altered or is malformed. */
export function decryptEntry(key: Buffer, entry: EncryptedEntry): StoredGrant | undefined {
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(entry.iv, 'base64url'));
    decipher.setAAD(Buffer.from(entry.id, 'utf8'));
    decipher.setAuthTag(Buffer.from(entry.tag, 'base64url'));
    const plain = Buffer.concat([decipher.update(Buffer.from(entry.data, 'base64url')), decipher.final()]);
    const grant = JSON.parse(plain.toString('utf8')) as Partial<StoredGrant>;
    if (
      typeof grant.clientId !== 'string' ||
      typeof grant.grantId !== 'string' ||
      typeof grant.system !== 'string' ||
      typeof grant.username !== 'string' ||
      typeof grant.password !== 'string' ||
      typeof grant.expiresAt !== 'number'
    ) {
      return undefined;
    }
    return grant as StoredGrant;
  } catch {
    return undefined;
  }
}

function isEncryptedEntry(value: unknown): value is EncryptedEntry {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const entry = value as Record<string, unknown>;
  return ['id', 'iv', 'tag', 'data'].every((field) => typeof entry[field] === 'string');
}

/**
 * Refresh grants keyed by grantId(refreshToken), in memory and optionally in
 * an encrypted file. Writes are synchronous and rewrite the whole file, which
 * holds at most MCP_MAX_SESSIONS entries. A failed write is logged and never
 * fails the OAuth request: the grant still works until the next restart.
 */
export class RefreshGrantStore {
  private readonly grants = new Map<string, RefreshGrant>();
  /** Encrypted form of each grant, so a rewrite does not encrypt everything again. */
  private readonly encrypted = new Map<string, EncryptedEntry>();
  private readonly key: Buffer | undefined;

  /**
   * @param file - State file path, or undefined to keep grants in memory only
   * @param secret - MCP_OAUTH_SECRET, required with a file
   */
  constructor(
    private readonly file?: string,
    secret?: Buffer
  ) {
    if (file && !secret) {
      throw new Error('A refresh grant state file needs a secret');
    }
    this.key = file && secret ? deriveStoreKey(secret) : undefined;
  }

  /** True when grants are also written to a state file. */
  get persistent(): boolean {
    return this.key !== undefined;
  }

  get size(): number {
    return this.grants.size;
  }

  get(id: string): RefreshGrant | undefined {
    return this.grants.get(id);
  }

  /** Grants with their store keys. Copied, so the caller may delete while iterating. */
  entries(): Array<[string, RefreshGrant]> {
    return [...this.grants];
  }

  set(id: string, grant: RefreshGrant): void {
    this.grants.set(id, grant);
    if (this.key) {
      this.encrypted.set(id, encryptEntry(this.key, id, {
        clientId: grant.clientId,
        grantId: grant.grantId,
        system: grant.system,
        username: grant.config.username,
        password: grant.config.password,
        expiresAt: grant.expiresAt,
      }));
    }
    this.save();
  }

  delete(id: string): boolean {
    return this.deleteMany([id]) > 0;
  }

  /** Delete several grants with one write. Returns how many existed. */
  deleteMany(ids: Iterable<string>): number {
    let deleted = 0;
    for (const id of ids) {
      if (this.grants.delete(id)) {
        deleted++;
      }
      this.encrypted.delete(id);
    }
    if (deleted > 0) {
      this.save();
    }
    return deleted;
  }

  /** Drop expired grants. */
  sweepExpired(now: number): void {
    this.deleteMany(this.entries().filter(([, grant]) => grant.expiresAt <= now).map(([id]) => id));
  }

  /** Forget every grant in memory. The state file is left as it is, for the next start. */
  clear(): void {
    this.grants.clear();
    this.encrypted.clear();
  }

  /**
   * Read the state file into memory. A missing file is an empty store. A file
   * written under another secret, and entries that were altered, expired or
   * cannot be restored, are skipped with a warning: those users sign in again.
   *
   * @param restore - Rebuilds a live grant from a stored one
   * @param now - Current time, for dropping expired grants
   */
  load(restore: GrantRestorer, now = Date.now()): void {
    this.clear();
    if (!this.file || !this.key) {
      return;
    }

    let raw: string;
    try {
      raw = readFileSync(this.file, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        log.warn({ err, file: this.file }, 'Could not read the OAuth state file; starting with no refresh grants');
      }
      return;
    }

    let state: Partial<StateFile>;
    try {
      state = JSON.parse(raw) as Partial<StateFile>;
    } catch {
      log.warn({ file: this.file }, 'The OAuth state file is not valid JSON; starting with no refresh grants');
      return;
    }
    if (state.version !== FILE_VERSION || !Array.isArray(state.grants)) {
      log.warn({ file: this.file, version: state.version }, 'Unknown OAuth state file format; starting with no refresh grants');
      return;
    }
    if (state.keyCheck !== keyCheckFor(this.key)) {
      log.warn({ file: this.file }, 'The OAuth state file was written with another MCP_OAUTH_SECRET; users must sign in again');
      return;
    }

    let skipped = 0;
    for (const entry of state.grants) {
      const stored = isEncryptedEntry(entry) ? decryptEntry(this.key, entry) : undefined;
      if (!stored) {
        skipped++;
        continue;
      }
      if (stored.expiresAt <= now) {
        continue;
      }
      const grant = restore(stored);
      if (!grant) {
        skipped++;
        continue;
      }
      this.grants.set(entry.id, grant);
      this.encrypted.set(entry.id, entry);
    }
    if (skipped > 0) {
      log.warn({ file: this.file, skipped }, 'Skipped OAuth refresh grants that could not be restored');
    }
    log.info({ file: this.file, grants: this.grants.size }, 'Loaded OAuth refresh grants');
    // Leave the file with only what was kept
    this.save();
  }

  /** Write every grant to the state file: a temp file, then a rename. */
  private save(): void {
    if (!this.file || !this.key) {
      return;
    }
    const state: StateFile = {
      version: FILE_VERSION,
      keyCheck: keyCheckFor(this.key),
      grants: [...this.encrypted.values()],
    };
    const temp = `${this.file}.${process.pid}.tmp`;
    try {
      mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
      writeFileSync(temp, JSON.stringify(state), { mode: 0o600 });
      // mode only applies when the file is created
      chmodSync(temp, 0o600);
      renameSync(temp, this.file);
    } catch (err) {
      log.error({ err, file: this.file }, 'Could not write the OAuth state file; refresh grants will not survive a restart');
      try {
        rmSync(temp, { force: true });
      } catch {
        // Nothing more to do: the next write replaces it
      }
    }
  }
}
