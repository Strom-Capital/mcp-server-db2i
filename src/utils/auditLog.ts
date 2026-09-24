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

export interface AuditCall {
  tool: string;
  identity: string;
  sql?: string | null;
  params?: unknown[];
  args?: Record<string, unknown>;
  rowCount?: number;
  durationMs?: number;
  outcome: 'success' | 'error' | 'rate_limited';
  error?: string;
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
    throw new Error(`MCP_AUDIT_LOG is not writable (${path}): ${message}`);
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

/** Append one audit line. No-op when the audit log is off. Never throws. */
export function writeAudit(entry: AuditCall): void {
  if (!config) {
    return;
  }
  const line = `${JSON.stringify(formatEntry(entry, config))}\n`;
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
    sql: formatSql(entry.sql, current.sql),
    outcome: entry.outcome,
  };
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
  if (entry.durationMs !== undefined) {
    line.durationMs = entry.durationMs;
  }
  if (entry.error !== undefined) {
    line.error = entry.error;
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
