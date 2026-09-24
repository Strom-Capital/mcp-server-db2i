/**
 * SSH host key check for the mapepire driver.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createHostKeyVerifier,
  fingerprintOf,
  knownHostKeys,
} from '../../src/db/drivers/sshHostKey.js';

// Host key blobs only need to be distinct bytes for these checks.
const KEY_A = Buffer.from('host-key-a');
const KEY_B = Buffer.from('host-key-b');
const b64 = (key: Buffer) => key.toString('base64');

function hashedName(name: string): string {
  const salt = randomBytes(20);
  const hash = createHmac('sha1', salt).update(name).digest();
  return `|1|${salt.toString('base64')}|${hash.toString('base64')}`;
}

let dir: string;
function knownHosts(contents: string): string {
  const file = join(dir, `known_hosts_${randomBytes(4).toString('hex')}`);
  writeFileSync(file, contents);
  return file;
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'db2i-hostkey-'));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('fingerprintOf', () => {
  it('matches the OpenSSH SHA256 format without padding', () => {
    const expected = createHash('sha256').update(KEY_A).digest('base64').replace(/=+$/, '');
    expect(fingerprintOf(KEY_A)).toBe(`SHA256:${expected}`);
  });
});

describe('knownHostKeys', () => {
  it('finds plain, wildcard and hashed entries, and skips others', () => {
    const contents = [
      '# comment',
      `ibmi.example.com,10.0.0.5 ssh-ed25519 ${b64(KEY_A)}`,
      `*.example.com ssh-rsa ${b64(KEY_B)} comment`,
      `other.example.com ssh-ed25519 ${b64(KEY_B)}`,
      `@cert-authority *.example.com ssh-ed25519 ${b64(KEY_B)}`,
      `${hashedName('ibmi.example.com')} ecdsa-sha2-nistp256 ${b64(KEY_B)}`,
    ].join('\n');
    const { keys, types } = knownHostKeys(contents, 'ibmi.example.com', 22);
    expect(keys.map((key) => key.toString())).toEqual(['host-key-a', 'host-key-b', 'host-key-b']);
    expect(types).toEqual(['ssh-ed25519', 'ssh-rsa', 'ecdsa-sha2-nistp256']);
  });

  it('uses [host]:port off port 22', () => {
    const contents = [
      `ibmi.example.com ssh-ed25519 ${b64(KEY_A)}`,
      `[ibmi.example.com]:2222 ssh-ed25519 ${b64(KEY_B)}`,
    ].join('\n');
    expect(knownHostKeys(contents, 'ibmi.example.com', 2222).keys).toEqual([KEY_B]);
    expect(knownHostKeys(contents, 'ibmi.example.com', 22).keys).toEqual([KEY_A]);
  });

  it('honours a negated pattern', () => {
    const contents = `*.example.com,!ibmi.example.com ssh-ed25519 ${b64(KEY_A)}`;
    expect(knownHostKeys(contents, 'ibmi.example.com', 22).keys).toEqual([]);
    expect(knownHostKeys(contents, 'test.example.com', 22).keys).toEqual([KEY_A]);
  });
});

describe('createHostKeyVerifier', () => {
  it('accepts a pinned fingerprint and refuses another key', () => {
    const verifier = createHostKeyVerifier(
      { hostKeyCheck: 'pinned', hostKey: fingerprintOf(KEY_A), knownHostsFile: '/nonexistent' },
      'ibmi.example.com',
      22
    );
    expect(verifier.verify(KEY_A)).toBe(true);
    expect(verifier.rejection()).toBeUndefined();
    expect(verifier.verify(KEY_B)).toBe(false);
    expect(verifier.rejection()).toContain(fingerprintOf(KEY_B));
    expect(verifier.algorithms()).toBeUndefined();
  });

  it('accepts a key listed in known_hosts and offers only its key types', () => {
    const file = knownHosts(`ibmi.example.com ssh-rsa ${b64(KEY_A)}\n`);
    const verifier = createHostKeyVerifier({ hostKeyCheck: 'known_hosts', knownHostsFile: file }, 'ibmi.example.com', 22);
    expect(verifier.verify(KEY_A)).toBe(true);
    expect(verifier.algorithms()).toEqual(['rsa-sha2-512', 'rsa-sha2-256', 'ssh-rsa']);
  });

  it('refuses a key that differs from known_hosts', () => {
    const file = knownHosts(`ibmi.example.com ssh-ed25519 ${b64(KEY_A)}\n`);
    const verifier = createHostKeyVerifier({ hostKeyCheck: 'known_hosts', knownHostsFile: file }, 'ibmi.example.com', 22);
    expect(verifier.verify(KEY_B)).toBe(false);
    expect(verifier.rejection()).toMatch(/does not match .*may have changed/);
  });

  it('refuses an unknown host and names the key to pin', () => {
    const file = knownHosts(`other.example.com ssh-ed25519 ${b64(KEY_A)}\n`);
    const verifier = createHostKeyVerifier({ hostKeyCheck: 'known_hosts', knownHostsFile: file }, 'ibmi.example.com', 22);
    expect(verifier.verify(KEY_A)).toBe(false);
    expect(verifier.rejection()).toContain(`hostKey=${fingerprintOf(KEY_A)}`);
    expect(verifier.algorithms()).toBeUndefined();
  });

  it('refuses a revoked key even when it is also listed', () => {
    const file = knownHosts(
      [`ibmi.example.com ssh-ed25519 ${b64(KEY_A)}`, `@revoked ibmi.example.com ssh-ed25519 ${b64(KEY_A)}`].join('\n')
    );
    const verifier = createHostKeyVerifier({ hostKeyCheck: 'known_hosts', knownHostsFile: file }, 'ibmi.example.com', 22);
    expect(verifier.verify(KEY_A)).toBe(false);
    expect(verifier.rejection()).toContain('@revoked');
  });

  it('refuses when the known_hosts file cannot be read', () => {
    const verifier = createHostKeyVerifier(
      { hostKeyCheck: 'known_hosts', knownHostsFile: join(dir, 'missing') },
      'ibmi.example.com',
      22
    );
    expect(verifier.verify(KEY_A)).toBe(false);
    expect(verifier.rejection()).toContain('Cannot read');
  });

  it('accepts any key when the check is off', () => {
    const verifier = createHostKeyVerifier({ hostKeyCheck: 'off', knownHostsFile: '/nonexistent' }, 'ibmi.example.com', 22);
    expect(verifier.verify(KEY_A)).toBe(true);
    expect(verifier.verify(KEY_B)).toBe(true);
  });
});
