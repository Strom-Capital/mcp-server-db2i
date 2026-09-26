/**
 * OAuth refresh grant store: in-memory map plus the encrypted state file.
 */

import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { DB2iConfig } from '../src/config.js';
import { grantKey, RefreshGrantStore, type RefreshGrant, type StoredGrant } from '../src/auth/grantStore.js';

const SECRET = Buffer.from('s'.repeat(40));
const OTHER_SECRET = Buffer.from('o'.repeat(40));

function config(username: string, password: string): DB2iConfig {
  return {
    hostname: 'ibmi.example.com',
    port: 8471,
    username,
    password,
    database: '*LOCAL',
    schema: 'MYLIB',
    driver: 'jt400',
    jdbcOptions: {},
    odbcOptions: {},
  };
}

function grant(overrides: Partial<RefreshGrant> = {}): RefreshGrant {
  return {
    clientId: 'client-1',
    grantId: 'grant-1',
    user: 'test\nCALLER',
    system: 'test',
    config: config('CALLER', 'callerpass'),
    expiresAt: Date.now() + 60_000,
    ...overrides,
  };
}

/** Rebuilds a grant the way oauth.ts does, without the profiles. */
function restore(stored: StoredGrant): RefreshGrant {
  return {
    clientId: stored.clientId,
    grantId: stored.grantId,
    user: `${stored.system}\n${stored.username}`,
    system: stored.system,
    config: config(stored.username, stored.password),
    expiresAt: stored.expiresAt,
  };
}

describe('RefreshGrantStore', () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'db2i-grants-'));
    file = path.join(dir, 'oauth', 'grants.json');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('keeps grants in memory only without a file', () => {
    const store = new RefreshGrantStore();
    store.set(grantKey('token-1'), grant());
    expect(store.persistent).toBe(false);
    expect(store.get(grantKey('token-1'))?.clientId).toBe('client-1');
    store.load(restore);
    expect(store.size).toBe(0);
  });

  it('refuses a file without a secret', () => {
    expect(() => new RefreshGrantStore(file)).toThrow(/needs a secret/);
  });

  it('reads back what it wrote after a restart', () => {
    const first = new RefreshGrantStore(file, SECRET);
    first.set(grantKey('token-1'), grant());
    first.set(grantKey('token-2'), grant({ grantId: 'grant-2', config: config('OTHER', 'otherpass') }));

    const second = new RefreshGrantStore(file, SECRET);
    second.load(restore);
    expect(second.size).toBe(2);
    expect(second.get(grantKey('token-1'))?.config.password).toBe('callerpass');
    expect(second.get(grantKey('token-2'))?.config.username).toBe('OTHER');
  });

  it('writes neither the refresh token nor the password in the clear', () => {
    const store = new RefreshGrantStore(file, SECRET);
    store.set(grantKey('refresh-token-value'), grant());
    const raw = readFileSync(file, 'utf8');
    expect(raw).not.toContain('refresh-token-value');
    expect(raw).not.toContain('callerpass');
    expect(raw).not.toContain('CALLER');
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
  });

  it('writes deletions', () => {
    const first = new RefreshGrantStore(file, SECRET);
    first.set(grantKey('token-1'), grant());
    first.set(grantKey('token-2'), grant({ grantId: 'grant-2' }));
    expect(first.deleteMany([grantKey('token-1'), grantKey('unknown')])).toBe(1);

    const second = new RefreshGrantStore(file, SECRET);
    second.load(restore);
    expect(second.get(grantKey('token-1'))).toBeUndefined();
    expect(second.get(grantKey('token-2'))).toBeDefined();
  });

  it('keeps the file when memory is cleared', () => {
    const first = new RefreshGrantStore(file, SECRET);
    first.set(grantKey('token-1'), grant());
    first.clear();

    const second = new RefreshGrantStore(file, SECRET);
    second.load(restore);
    expect(second.size).toBe(1);
  });

  it('starts empty when the secret changed', () => {
    new RefreshGrantStore(file, SECRET).set(grantKey('token-1'), grant());

    const rotated = new RefreshGrantStore(file, OTHER_SECRET);
    rotated.load(restore);
    expect(rotated.size).toBe(0);
    // The old grants are not readable with the new secret either way; the first write replaces them
    rotated.set(grantKey('token-2'), grant());
    const again = new RefreshGrantStore(file, OTHER_SECRET);
    again.load(restore);
    expect(again.size).toBe(1);
  });

  it('skips an altered entry and keeps the others', () => {
    const store = new RefreshGrantStore(file, SECRET);
    store.set(grantKey('token-1'), grant());
    store.set(grantKey('token-2'), grant({ grantId: 'grant-2' }));

    const state = JSON.parse(readFileSync(file, 'utf8')) as { grants: Array<{ id: string; data: string }> };
    const data = Buffer.from(state.grants[0].data, 'base64url');
    data[0] ^= 1;
    state.grants[0].data = data.toString('base64url');
    // Moving an entry to another ID does not work either
    state.grants.push({ ...state.grants[1], id: grantKey('token-3') });
    writeFileSync(file, JSON.stringify(state));

    const reloaded = new RefreshGrantStore(file, SECRET);
    reloaded.load(restore);
    expect(reloaded.size).toBe(1);
    expect(reloaded.get(grantKey('token-2'))).toBeDefined();
    expect(reloaded.get(grantKey('token-3'))).toBeUndefined();
  });

  it('drops expired grants and grants that cannot be restored', () => {
    const now = Date.now();
    const store = new RefreshGrantStore(file, SECRET);
    store.set(grantKey('expired'), grant({ expiresAt: now - 1 }));
    store.set(grantKey('removed'), grant({ system: 'gone' }));
    store.set(grantKey('kept'), grant());

    const reloaded = new RefreshGrantStore(file, SECRET);
    reloaded.load((stored) => (stored.system === 'gone' ? undefined : restore(stored)), now);
    expect(reloaded.entries().map(([key]) => key)).toEqual([grantKey('kept')]);

    // The file now holds only what was kept
    const state = JSON.parse(readFileSync(file, 'utf8')) as { grants: unknown[] };
    expect(state.grants).toHaveLength(1);
  });

  it('sweeps expired grants', () => {
    const store = new RefreshGrantStore(file, SECRET);
    store.set(grantKey('expired'), grant({ expiresAt: Date.now() - 1 }));
    store.set(grantKey('kept'), grant());
    store.sweepExpired(Date.now());
    expect(store.size).toBe(1);
  });

  it('starts empty on an unreadable or unknown file', () => {
    const store = new RefreshGrantStore(file, SECRET);
    store.set(grantKey('token-1'), grant());

    writeFileSync(file, 'not json');
    store.load(restore);
    expect(store.size).toBe(0);

    writeFileSync(file, JSON.stringify({ version: 99, grants: [] }));
    store.load(restore);
    expect(store.size).toBe(0);
  });

  it('keeps working in memory when the file cannot be written', () => {
    // The parent "directory" is a file, so every write fails
    writeFileSync(path.join(dir, 'blocked'), '');
    const store = new RefreshGrantStore(path.join(dir, 'blocked', 'grants.json'), SECRET);
    expect(() => store.set(grantKey('token-1'), grant())).not.toThrow();
    expect(store.get(grantKey('token-1'))).toBeDefined();
  });
});
