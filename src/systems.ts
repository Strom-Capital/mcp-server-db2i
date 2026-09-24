/**
 * IBM i systems the server can reach.
 *
 * DB2I_PROFILES points at a YAML file with one entry per system. Without it,
 * the DB2I_* environment variables form one system named `default`, so a
 * single-system install needs no file.
 *
 * Passwords never sit in the file: `password` must be a `${ENV_VAR}`
 * reference, or `passwordFile` a path to read. `username` may be either, or
 * plain text.
 */

import { readFileSync } from 'node:fs';

import { parseDocument } from 'yaml';
import { z } from 'zod';

import {
  DB_DRIVERS,
  DEFAULT_SYSTEM_NAME,
  getAllowedSchemas,
  getDbDriver,
  loadConfig,
  normalizeSchemaList,
  parseJdbcOptions,
  readSecretFromFile,
  usesSshKeyLogin,
  validateHostname,
  type DB2iConfig,
} from './config.js';
import { formatSchemaIssues } from './customTools/schema.js';
import { createChildLogger } from './utils/logger.js';

export { DEFAULT_SYSTEM_NAME };

/** Pool owner for the stdio transport. HTTP owners are session keys. */
export const STDIO_POOL_KEY = 'stdio';

const log = createChildLogger({ component: 'systems' });

const SYSTEM_NAME = /^[A-Za-z0-9_-]{1,64}$/;
const ENV_REFERENCE = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/;

export interface SystemProfile {
  name: string;
  config: DB2iConfig;
  /** Uppercased libraries queries may use. Undefined turns the check off. */
  allowedSchemas?: string[];
  /** Library unqualified names resolve to. */
  defaultSchema?: string;
}

export class SystemsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SystemsError';
  }
}

const profileSchema = z.strictObject({
  name: z.string().regex(SYSTEM_NAME, 'name may use letters, digits, _ and -, up to 64 characters'),
  host: z.string().min(1),
  driver: z.enum(DB_DRIVERS).optional(),
  schema: z.string().optional(),
  allowedSchemas: z.array(z.string().min(1)).min(1).optional(),
  username: z.string().min(1).optional(),
  usernameFile: z.string().min(1).optional(),
  password: z.string().min(1).optional(),
  passwordFile: z.string().min(1).optional(),
  jdbcOptions: z.string().optional(),
  odbcOptions: z.string().optional(),
  mapepireOptions: z.string().optional(),
});

const profilesFileSchema = z.strictObject({
  profiles: z.array(profileSchema).min(1),
});

type ProfileDef = z.infer<typeof profileSchema>;

let cached: { file: string; systems: SystemProfile[] } | undefined;

/**
 * Systems from DB2I_PROFILES, or the implicit `default` system from DB2I_*.
 * A profiles file is read once and cached; call resetSystems() to reload.
 * The implicit system reads the environment on every call, as the single-system
 * settings always have.
 */
export function getSystems(): SystemProfile[] {
  const file = process.env.DB2I_PROFILES?.trim();
  if (!file) {
    return [envSystem()];
  }
  if (cached?.file !== file) {
    cached = { file, systems: loadSystems(file) };
  }
  return cached.systems;
}

/** Forget the cached registry. For tests. */
export function resetSystems(): void {
  cached = undefined;
}

export function isProfilesFileConfigured(): boolean {
  return Boolean(process.env.DB2I_PROFILES?.trim());
}

/** The first profile, used when a call names no system. */
export function defaultSystem(): SystemProfile {
  return getSystems()[0];
}

export function getSystem(name: string): SystemProfile | undefined {
  return getSystems().find((system) => system.name === name);
}

export function systemNames(): string[] {
  return getSystems().map((system) => system.name);
}

/**
 * The error a call gets for a system name that is not configured.
 */
export function unknownSystemMessage(name: string): string {
  return `Unknown system "${name}". Available: ${systemNames().join(', ')}`;
}

function loadSystems(file: string): SystemProfile[] {
  if (process.env.DB2I_HOSTNAME) {
    log.warn(
      'DB2I_PROFILES is set, so DB2I_HOSTNAME and the other connection variables are ignored'
    );
  }
  return loadProfilesFile(file);
}

/**
 * The implicit system from DB2I_*. Its config is read on first use: HTTP in
 * `required` mode takes credentials at /auth, so DB2I_USERNAME and
 * DB2I_PASSWORD may be unset.
 */
function envSystem(): SystemProfile {
  let config: DB2iConfig | undefined;
  return {
    name: DEFAULT_SYSTEM_NAME,
    get config(): DB2iConfig {
      config ??= loadConfig();
      return config;
    },
    allowedSchemas: getAllowedSchemas(),
    defaultSchema: process.env.DB2I_SCHEMA || undefined,
  };
}

function loadProfilesFile(file: string): SystemProfile[] {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Could not read file';
    throw new SystemsError(`DB2I_PROFILES (${file}): ${message}`);
  }

  const doc = parseDocument(text, { schema: 'core' });
  if (doc.errors.length > 0) {
    throw new SystemsError(
      `DB2I_PROFILES (${file}): ${doc.errors.map((error) => error.message).join('; ')}`
    );
  }

  const parsed = profilesFileSchema.safeParse(doc.toJS());
  if (!parsed.success) {
    throw new SystemsError(`DB2I_PROFILES (${file}): ${formatSchemaIssues(parsed.error)}`);
  }

  const seen = new Set<string>();
  return parsed.data.profiles.map((def) => {
    const where = `DB2I_PROFILES (${file}): profile ${def.name}`;
    if (seen.has(def.name)) {
      throw new SystemsError(`${where}: the name is used more than once`);
    }
    seen.add(def.name);
    return toSystem(def, where);
  });
}

function toSystem(def: ProfileDef, where: string): SystemProfile {
  if (!validateHostname(def.host)) {
    throw new SystemsError(`${where}: host "${def.host}" is not a valid hostname or IPv4 address`);
  }

  const driver = def.driver ?? getDbDriver();
  const mapepireOptions = parseJdbcOptions(def.mapepireOptions);
  const username = credential(def.username, def.usernameFile, 'username', where);
  // A mapepire profile that logs in with an SSH key needs no password.
  const keyLogin =
    usesSshKeyLogin(driver, mapepireOptions) && def.password === undefined && def.passwordFile === undefined;
  const password = keyLogin ? '' : credential(def.password, def.passwordFile, 'password', where);
  const schema = def.schema?.trim() ?? '';

  return {
    name: def.name,
    config: {
      hostname: def.host.trim(),
      port: 446,
      username,
      password,
      database: '*LOCAL',
      schema,
      driver,
      jdbcOptions: parseJdbcOptions(def.jdbcOptions),
      odbcOptions: parseJdbcOptions(def.odbcOptions),
      mapepireOptions,
    },
    allowedSchemas: def.allowedSchemas ? normalizeSchemaList(def.allowedSchemas) : getAllowedSchemas(),
    defaultSchema: schema || undefined,
  };
}

/**
 * Resolve a credential from a `${ENV_VAR}` reference or a file path.
 * A literal password is refused so the file never holds a secret.
 */
function credential(
  value: string | undefined,
  file: string | undefined,
  field: 'username' | 'password',
  where: string,
): string {
  if (value !== undefined && file !== undefined) {
    throw new SystemsError(`${where}: set ${field} or ${field}File, not both`);
  }

  if (file !== undefined) {
    const expanded = expandReference(file, `${field}File`, where);
    if (expanded === '') {
      throw new SystemsError(`${where}: ${file} is not set`);
    }
    let resolved: string;
    try {
      resolved = readSecretFromFile(expanded ?? file);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Could not read file';
      throw new SystemsError(`${where}: ${message}`);
    }
    if (!resolved) {
      throw new SystemsError(`${where}: ${field}File ${file} is empty`);
    }
    return resolved;
  }

  if (value === undefined) {
    throw new SystemsError(`${where}: ${field} is required (a \${ENV_VAR} reference, or ${field}File)`);
  }

  const resolved = expandReference(value, field, where);
  if (resolved === undefined && field === 'username') {
    return value.trim();
  }
  if (resolved === undefined) {
    throw new SystemsError(
      `${where}: ${field} must be a \${ENV_VAR} reference. Put the value in the environment, or use ${field}File.`
    );
  }
  if (!resolved) {
    throw new SystemsError(`${where}: ${value} is not set`);
  }
  return resolved;
}

/**
 * Value of a `${NAME}` reference, '' when the variable is unset, or undefined
 * when the text is not a reference.
 */
function expandReference(text: string, field: string, where: string): string | undefined {
  const match = ENV_REFERENCE.exec(text.trim());
  if (!match) {
    if (text.includes('${')) {
      throw new SystemsError(`${where}: ${field} must be exactly one \${ENV_VAR} reference`);
    }
    return undefined;
  }
  return process.env[match[1]] ?? '';
}

/**
 * Where one tool call runs: the pool owner, the system, and that system's
 * connection settings and query policy.
 */
export interface DbTarget {
  /** Pool owner: `stdio`, or the HTTP caller's session key. */
  poolKey: string;
  system: string;
  config: DB2iConfig;
  /** Uppercased libraries queries may use. Undefined turns the check off. */
  allowedSchemas?: string[];
  /** Library unqualified names resolve to. */
  defaultSchema?: string;
}

/**
 * An HTTP session that logged in at /auth. Its credentials were checked on one
 * system, so every call from it runs there.
 */
export interface SystemBinding {
  system: string;
  config: DB2iConfig;
}

export class TargetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TargetError';
  }
}

/**
 * Resolve the system a call asked for. Omitted means the session's system, or
 * the first profile.
 *
 * @throws TargetError for an unknown name, or one a bound session may not use
 */
export function resolveTarget(poolKey: string, requested?: string, binding?: SystemBinding): DbTarget {
  if (binding) {
    if (requested !== undefined && requested !== binding.system) {
      throw new TargetError(
        `This session is bound to system "${binding.system}". Log in at /auth with system "${requested}" to use it.`
      );
    }
    const profile = getSystem(binding.system);
    return {
      poolKey,
      system: binding.system,
      config: binding.config,
      allowedSchemas: profile ? profile.allowedSchemas : getAllowedSchemas(),
      defaultSchema: binding.config.schema || undefined,
    };
  }

  const profile = requested === undefined ? defaultSystem() : getSystem(requested);
  if (!profile) {
    throw new TargetError(unknownSystemMessage(requested ?? ''));
  }
  return {
    poolKey,
    system: profile.name,
    // Read on first query, so a call that never connects needs no credentials
    get config(): DB2iConfig {
      return profile.config;
    },
    allowedSchemas: profile.allowedSchemas,
    defaultSchema: profile.defaultSchema,
  };
}

/**
 * The target's allowlist, or QUERY_ALLOWED_SCHEMAS for a caller that passes
 * no target (the CLI, and code that predates systems).
 */
export function allowedSchemasFor(target?: DbTarget): string[] | undefined {
  return target ? target.allowedSchemas : getAllowedSchemas();
}
