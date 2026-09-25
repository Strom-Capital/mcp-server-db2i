/**
 * IBM i login shared by POST /auth and the OAuth login page.
 *
 * A login picks a system (a DB2I_PROFILES profile, or the DB2I_* host),
 * puts the caller's own credentials on it, and proves them with a test
 * connection. The resulting config is what the caller's token runs queries with.
 */

import crypto from 'node:crypto';

import {
  getHttpConfig,
  loadPartialConfig,
  normalizeDbHost,
  withoutSshKeyLogin,
  type DB2iConfig,
} from '../config.js';
import { closeSessionPool, initializeSessionPool, testConnection } from '../db/connection.js';
import {
  DEFAULT_SYSTEM_NAME,
  defaultSystem,
  getSystem,
  getSystems,
  isProfilesFileConfigured,
  unknownSystemMessage,
} from '../systems.js';
import { createChildLogger } from '../utils/logger.js';
import type { AuthRequest } from './types.js';

const log = createChildLogger({ component: 'login' });

/** Outcome of a login attempt. */
export type LoginResult =
  | { ok: true; system: string; config: DB2iConfig }
  | {
      ok: false;
      /** 400 for a request that names a bad system or host, 401 for rejected credentials. */
      status: 400 | 401;
      error: 'invalid_request' | 'invalid_credentials';
      description: string;
    };

/**
 * Hosts a login may connect to. With DB2I_PROFILES and no explicit
 * MCP_AUTH_ALLOWED_DB_HOSTS, the profile hosts.
 *
 * @returns The allowed hosts, or null when any host is accepted
 */
export function authAllowedDbHosts(): string[] | null {
  if (isProfilesFileConfigured() && !process.env.MCP_AUTH_ALLOWED_DB_HOSTS?.trim()) {
    return [...new Set(getSystems().map((system) => normalizeDbHost(system.config.hostname)))];
  }
  return getHttpConfig().authAllowedDbHosts;
}

/**
 * The connection a login asks for: a profile plus the caller's
 * credentials, or, without DB2I_PROFILES, the request's host over DB2I_*.
 * The caller's password is what logs in, so a mapepire privateKeyFile is
 * dropped: the server's key would accept any password.
 *
 * @throws Error when the request names an unknown system or a field profiles do not accept
 */
export function authConnection(authReq: AuthRequest): { system: string; config: DB2iConfig } {
  if (!isProfilesFileConfigured()) {
    if (authReq.system !== undefined && authReq.system !== DEFAULT_SYSTEM_NAME) {
      throw new Error(unknownSystemMessage(authReq.system));
    }
    const config = loadPartialConfig({
      hostname: authReq.host,
      port: authReq.port,
      username: authReq.username,
      password: authReq.password,
      database: authReq.database,
      schema: authReq.schema,
    });
    return {
      system: DEFAULT_SYSTEM_NAME,
      config: { ...config, mapepireOptions: withoutSshKeyLogin(config.mapepireOptions) },
    };
  }

  if (authReq.host !== undefined || authReq.port !== undefined || authReq.database !== undefined) {
    throw new Error('host, port, and database come from DB2I_PROFILES. Choose a profile with system.');
  }
  const profile = authReq.system === undefined ? defaultSystem() : getSystem(authReq.system);
  if (!profile) {
    throw new Error(unknownSystemMessage(authReq.system ?? ''));
  }
  return {
    system: profile.name,
    config: {
      ...profile.config,
      username: authReq.username,
      password: authReq.password,
      schema: authReq.schema ?? profile.config.schema,
      mapepireOptions: withoutSshKeyLogin(profile.config.mapepireOptions),
    },
  };
}

/**
 * Prove a config's credentials by opening a throwaway pool and running a test query.
 *
 * @returns null on success, or the reason the connection failed
 */
export async function testCredentials(system: string, config: DB2iConfig): Promise<string | null> {
  log.debug({ host: config.hostname, user: config.username, system }, 'Testing credentials');
  // A random pool ID keeps concurrent logins apart
  const testPoolId = `auth-test-${crypto.randomBytes(16).toString('hex')}`;
  try {
    initializeSessionPool(testPoolId);
    const connected = await testConnection({ poolKey: testPoolId, system, config });
    return connected ? null : 'unable to connect to database';
  } catch (err) {
    return err instanceof Error ? err.message : 'Connection failed';
  } finally {
    await closeSessionPool(testPoolId);
  }
}

/**
 * Resolve a login request to a connection and check the credentials on the IBM i.
 *
 * @param authReq - Validated credentials and connection choices
 * @returns The system and config to bind a token to, or why the login failed
 */
export async function verifyLogin(authReq: AuthRequest): Promise<LoginResult> {
  let system: string;
  let config: DB2iConfig;
  try {
    ({ system, config } = authConnection(authReq));
  } catch (err) {
    return {
      ok: false,
      status: 400,
      error: 'invalid_request',
      description: err instanceof Error ? err.message : 'Configuration error',
    };
  }

  const allowedDbHosts = authAllowedDbHosts();
  if (allowedDbHosts && !allowedDbHosts.includes(normalizeDbHost(config.hostname))) {
    return { ok: false, status: 400, error: 'invalid_request', description: 'Host is not allowed' };
  }

  const failure = await testCredentials(system, config);
  if (failure !== null) {
    return {
      ok: false,
      status: 401,
      error: 'invalid_credentials',
      description: `Authentication failed: ${failure}`,
    };
  }
  return { ok: true, system, config };
}
