/**
 * One JSON line per tool call. Separate from the pino log.
 *
 * SQL is hashed unless MCP_AUDIT_SQL=full. Bound values are omitted unless
 * MCP_AUDIT_PARAMS=true. A failed write is reported once and does not fail the call.
 */

import { createHash } from 'node:crypto';
import * as fs from 'node:fs';

import { getAuditConfig, type AuditConfig } from '../config.js';
import { logger } from './logger.js';

/** Why a tool call failed, for grouping failures without parsing the error text. */
export type AuditErrorKind =
  | 'security_validation'
  | 'allowlist_parse'
  | 'allowlist_denied'
  | 'parse_check'
  | 'masking'
  | 'bad_params'
  | 'sql_error'
  | 'not_found'
  | 'unknown_system'
  | 'rate_limited'
  | 'exception'
  | 'other';

/** The MCP client that made a call, from its client info or, failing that, the HTTP User-Agent. */
export interface AuditClient {
  name?: string;
  version?: string;
  userAgent?: string;
}

export interface AuditCall {
  tool: string;
  identity: string;
  /** IBM i system the call ran on, or asked for when it failed before running. */
  system?: string;
  sql?: string | null;
  params?: unknown[];
  args?: Record<string, unknown>;
  /** The model's reason for the call, from the `context` argument (MCP_TOOL_INTENT). */
  intent?: string;
  client?: AuditClient;
  /** Short hash of the session key, so calls can be grouped without logging the key. */
  session?: string;
  rowCount?: number;
  /** The result stopped at a row or size limit and more rows matched. */
  truncated?: boolean;
  /** Annotated tables whose row filter the statement left out (execute_query, export_query, validate_query). */
  skippedFilters?: string[];
  /** Size of the file an export wrote. */
  bytes?: number;
  durationMs?: number;
  outcome: 'success' | 'error' | 'rate_limited';
  error?: string;
  errorKind?: AuditErrorKind;
  sqlstate?: string;
  sqlcode?: number;
  /** Rule violations the security validator or schema allowlist reported. */
  violations?: string[];
}

let config: AuditConfig | undefined;
let fd: number | undefined;
let writeFailureReported = false;

/** Open the file sink when MCP_AUDIT_LOG is a path. Throws when that path is not writable. */
export function initAuditLog(): void {
  closeAuditLog();
  writeFailureReported = false;
  config = getAuditConfig();
  if (!config || config.target === 'stderr') {
    return;
  }
  const path = config.target.path;
  try {
    fd = fs.openSync(path, 'a');
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Could not open audit log';
    config = undefined;
    throw new Error(`MCP_AUDIT_LOG is not writable (${path}): ${message}`, { cause: error });
  }
}

export function closeAuditLog(): void {
  if (fd !== undefined) {
    try {
      fs.closeSync(fd);
    } catch {
      // The process is exiting. A close failure does not change the lines already written.
    }
    fd = undefined;
  }
  config = undefined;
}

/** Short, stable hash of a session key. The key itself can be a bearer token, so it is never logged. */
export function auditSessionId(sessionKey: string): string {
  return createHash('sha256').update(sessionKey).digest('hex').slice(0, 12);
}

/** Append one audit line. No-op when the audit log is off. Never throws. */
export function writeAudit(entry: AuditCall): void {
  if (!config) {
    return;
  }
  writeLine(formatEntry(entry, config));
}

/** A server event that is not a tool call. */
export type AuditEvent =
  | { event: 'shutdown'; reason: string }
  | {
      /** A request for an export download link. */
      event: 'export_download';
      /** The first 8 characters of the export id. The full id is the link, so it is never logged. */
      exportId: string;
      /** Who ran the export. */
      identity: string;
      ip?: string;
      outcome: 'success' | 'not_found' | 'error';
      bytes?: number;
      rowCount?: number;
    }
  | {
      /** An IBM i sign-in at the OAuth sign-in page (`oauth`) or POST /auth (`password`). */
      event: 'sign_in';
      method: 'oauth' | 'password';
      /** The user name as entered. A failed sign-in may carry a mistyped name. */
      identity: string;
      system?: string;
      /** OAuth client name, as the client registered it. */
      client?: string;
      ip?: string;
      outcome: 'success' | 'failure' | 'rate_limited' | 'error';
      reason?: string;
    };

/** Append one event line, such as why the server shut down. No-op when the audit log is off. Never throws. */
export function writeAuditEvent(entry: AuditEvent): void {
  if (!config) {
    return;
  }
  writeLine({ time: new Date().toISOString(), ...entry });
}

function writeLine(record: Record<string, unknown>): void {
  if (!config) {
    return;
  }
  const line = `${JSON.stringify(record)}\n`;
  try {
    if (config.target === 'stderr') {
      process.stderr.write(line);
      return;
    }
    if (fd === undefined) {
      throw new Error('Audit log file is not open');
    }
    fs.writeSync(fd, line);
  } catch (error) {
    if (!writeFailureReported) {
      writeFailureReported = true;
      logger.error({ err: error }, 'Audit log write failed; further failures will not be logged');
    }
  }
}

function formatEntry(entry: AuditCall, current: AuditConfig): Record<string, unknown> {
  const line: Record<string, unknown> = {
    time: new Date().toISOString(),
    tool: entry.tool,
    identity: entry.identity,
    ...(entry.system ? { system: entry.system } : {}),
    sql: formatSql(entry.sql, current.sql),
    outcome: entry.outcome,
  };
  if (entry.intent !== undefined) {
    line.intent = entry.intent;
  }
  if (entry.client) {
    line.client = entry.client;
  }
  if (entry.session !== undefined) {
    line.session = entry.session;
  }
  if (entry.params) {
    line.paramCount = entry.params.length;
    if (current.params) {
      line.params = entry.params;
    }
  }
  if (entry.args && Object.keys(entry.args).length > 0) {
    line.args = entry.args;
  }
  if (entry.rowCount !== undefined) {
    line.rowCount = entry.rowCount;
  }
  if (entry.truncated) {
    line.truncated = true;
  }
  if (entry.skippedFilters && entry.skippedFilters.length > 0) {
    line.skippedFilters = entry.skippedFilters;
  }
  if (entry.bytes !== undefined) {
    line.bytes = entry.bytes;
  }
  if (entry.durationMs !== undefined) {
    line.durationMs = entry.durationMs;
  }
  if (entry.error !== undefined) {
    line.error = entry.error;
  }
  if (entry.errorKind !== undefined) {
    line.errorKind = entry.errorKind;
  }
  if (entry.sqlstate !== undefined) {
    line.sqlstate = entry.sqlstate;
  }
  if (entry.sqlcode !== undefined) {
    line.sqlcode = entry.sqlcode;
  }
  if (entry.violations && entry.violations.length > 0) {
    line.violations = entry.violations;
  }
  return line;
}

function formatSql(sql: string | null | undefined, mode: AuditConfig['sql']): string | null {
  if (sql == null) {
    return null;
  }
  if (mode === 'full') {
    return sql;
  }
  return `sha256:${createHash('sha256').update(sql).digest('hex')}`;
}
