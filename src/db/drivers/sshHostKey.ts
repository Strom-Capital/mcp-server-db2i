/**
 * SSH host key check for the mapepire driver.
 *
 * ssh2 accepts any host key unless a verifier says otherwise, and a spoofed
 * host would receive the IBM i password. The key must match a pinned
 * `SHA256:` fingerprint or an entry in a known_hosts file, unless the operator
 * turned the check off with insecureHostKey=true.
 */

import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { HostKeyCheck } from '../../config.js';

export interface HostKeyOptions {
  hostKeyCheck: HostKeyCheck;
  /** `SHA256:<base64>` without padding. Used when hostKeyCheck is pinned. */
  hostKey?: string;
  /** Used when hostKeyCheck is known_hosts. */
  knownHostsFile: string;
}

export interface HostKeyVerifier {
  /**
   * Host key algorithms for ssh2 to offer, so it negotiates a key type the
   * known_hosts file lists. Undefined keeps the ssh2 default.
   */
  algorithms(): string[] | undefined;
  /** For ssh2's `hostVerifier`: the raw host key blob. */
  verify(key: Buffer): boolean;
  /** Why the last key was refused, for the connection error. */
  rejection(): string | undefined;
}

/**
 * OpenSSH fingerprint of a host key blob, as `ssh-keygen -lf` prints it.
 */
export function fingerprintOf(key: Buffer): string {
  return `SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}`;
}

/** The name a known_hosts entry uses for this host: `host`, or `[host]:port` off port 22. */
function knownHostsName(host: string, port: number): string {
  return port === 22 ? host : `[${host}]:${port}`;
}

/** Match a known_hosts wildcard pattern (`*` and `?`) against a name, ignoring case. */
function matchesPattern(pattern: string, name: string): boolean {
  const regex = new RegExp(
    `^${pattern
      .toLowerCase()
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '.*')
      .replace(/\?/g, '.')}$`
  );
  return regex.test(name.toLowerCase());
}

/** Match a hashed entry, `|1|<salt>|<hmac-sha1 of the name>`. */
function matchesHashed(field: string, name: string): boolean {
  const parts = field.split('|');
  if (parts.length !== 4 || parts[1] !== '1') {
    return false;
  }
  const salt = Buffer.from(parts[2], 'base64');
  const expected = Buffer.from(parts[3], 'base64');
  const actual = createHmac('sha1', salt).update(name).digest();
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

/** Whether the host field of a known_hosts line names this host. */
function hostFieldMatches(field: string, name: string): boolean {
  if (field.startsWith('|')) {
    return matchesHashed(field, name);
  }
  let matched = false;
  for (const pattern of field.split(',')) {
    if (pattern.startsWith('!')) {
      if (matchesPattern(pattern.slice(1), name)) {
        return false;
      }
    } else if (matchesPattern(pattern, name)) {
      matched = true;
    }
  }
  return matched;
}

/** ssh2 host key algorithms for each known_hosts key type. */
const ALGORITHMS_BY_KEY_TYPE: Record<string, readonly string[]> = {
  'ssh-ed25519': ['ssh-ed25519'],
  'ecdsa-sha2-nistp256': ['ecdsa-sha2-nistp256'],
  'ecdsa-sha2-nistp384': ['ecdsa-sha2-nistp384'],
  'ecdsa-sha2-nistp521': ['ecdsa-sha2-nistp521'],
  'ssh-rsa': ['rsa-sha2-512', 'rsa-sha2-256', 'ssh-rsa'],
};

/**
 * Keys a known_hosts file lists for a host, their key types, and keys it marks
 * as revoked. `@cert-authority` lines are skipped: host certificates are not
 * supported.
 */
export function knownHostKeys(
  contents: string,
  host: string,
  port: number
): { keys: Buffer[]; types: string[]; revoked: Buffer[] } {
  const name = knownHostsName(host, port);
  const keys: Buffer[] = [];
  const types: string[] = [];
  const revoked: Buffer[] = [];
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) {
      continue;
    }
    const fields = line.split(/\s+/);
    let marker: string | undefined;
    if (fields[0].startsWith('@')) {
      marker = fields.shift();
    }
    if (marker === '@cert-authority' || fields.length < 3) {
      continue;
    }
    if (!hostFieldMatches(fields[0], name)) {
      continue;
    }
    const key = Buffer.from(fields[2], 'base64');
    if (marker === '@revoked') {
      revoked.push(key);
    } else {
      keys.push(key);
      if (!types.includes(fields[1])) {
        types.push(fields[1]);
      }
    }
  }
  return { keys, types, revoked };
}

/**
 * Build the verifier for one host. The known_hosts file is read on each
 * connection, so an updated file applies without a restart.
 */
export function createHostKeyVerifier(
  options: HostKeyOptions,
  host: string,
  port: number
): HostKeyVerifier {
  let lastRejection: string | undefined;

  const reject = (reason: string): false => {
    lastRejection = reason;
    return false;
  };

  return {
    algorithms(): string[] | undefined {
      if (options.hostKeyCheck !== 'known_hosts') {
        return undefined;
      }
      let contents: string;
      try {
        contents = readFileSync(options.knownHostsFile, 'utf8');
      } catch {
        return undefined;
      }
      const algorithms = knownHostKeys(contents, host, port).types.flatMap(
        (type) => ALGORITHMS_BY_KEY_TYPE[type] ?? []
      );
      return algorithms.length > 0 ? algorithms : undefined;
    },
    verify(key: Buffer): boolean {
      lastRejection = undefined;
      const fingerprint = fingerprintOf(key);

      if (options.hostKeyCheck === 'off') {
        return true;
      }

      if (options.hostKeyCheck === 'pinned') {
        if (fingerprint === options.hostKey) {
          return true;
        }
        return reject(
          `SSH host key of ${host} is ${fingerprint}, which does not match hostKey ${options.hostKey}. If the key changed on purpose, update hostKey.`
        );
      }

      let contents: string;
      try {
        contents = readFileSync(options.knownHostsFile, 'utf8');
      } catch {
        return reject(
          `Cannot read ${options.knownHostsFile} to check the SSH host key of ${host} (${fingerprint}). Connect once with ssh to add it, or set hostKey=${fingerprint} in DB2I_MAPEPIRE_OPTIONS after checking it.`
        );
      }

      const { keys, revoked } = knownHostKeys(contents, host, port);
      if (revoked.some((entry) => entry.equals(key))) {
        return reject(`SSH host key of ${host} (${fingerprint}) is marked @revoked in ${options.knownHostsFile}.`);
      }
      if (keys.some((entry) => entry.equals(key))) {
        return true;
      }
      if (keys.length > 0) {
        return reject(
          `SSH host key of ${host} (${fingerprint}) does not match ${options.knownHostsFile}. The key may have changed, or the connection may be intercepted.`
        );
      }
      return reject(
        `${host} is not in ${options.knownHostsFile}. Its SSH host key is ${fingerprint}. Connect once with ssh to add it, or set hostKey=${fingerprint} in DB2I_MAPEPIRE_OPTIONS after checking it.`
      );
    },
    rejection: () => lastRejection,
  };
}
