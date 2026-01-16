/**
 * Structured logging module using Pino
 *
 * Best Practices Implemented:
 * - All logs to stderr (MCP uses stdout for JSON-RPC protocol)
 * - JSON format in production (for log aggregation services)
 * - Pretty format in development (human-readable)
 * - Sensitive data redaction (passwords)
 * - TTY detection for ANSI colors
 * - Synchronous writes to prevent log loss on shutdown
 *
 * Configuration:
 * - NODE_ENV=production: JSON logs
 * - NODE_ENV=development (or unset): Pretty-printed logs
 * - LOG_PRETTY=true/false: Override format
 * - LOG_COLORS=true/false: Override colors
 * - LOG_LEVEL=debug|info|warn|error|fatal: Set verbosity
 */

import pino, { type Logger, type DestinationStream } from 'pino';
import pretty from 'pino-pretty';
import { getLogLevel, type LogLevel } from '../config.js';

// Re-export LogLevel for consumers who need the type
export type { LogLevel };

/**
 * Paths to redact in log output to prevent credential leaks.
 * Exported for use in tests to ensure redaction config stays in sync.
 */
export const REDACT_PATHS = ['password', '*.password', 'config.password'] as const;

/**
 * The censor string used to replace redacted values
 */
export const REDACT_CENSOR = '[REDACTED]';

/**
 * Check if running in production mode
 */
function isProduction(): boolean {
  return process.env.NODE_ENV === 'production';
}

/**
 * Check if stderr is a real terminal (TTY)
 * When running under Cursor MCP, stderr is piped, not a TTY
 */
function isTTY(): boolean {
  return process.stderr.isTTY === true;
}

/**
 * Determine if we should use pretty printing
 */
function usePrettyPrint(): boolean {
  if (process.env.LOG_PRETTY === 'true') return true;
  if (process.env.LOG_PRETTY === 'false') return false;
  return !isProduction();
}

/**
 * Determine if colors should be enabled
 */
function useColors(): boolean {
  if (process.env.LOG_COLORS === 'true') return true;
  if (process.env.LOG_COLORS === 'false') return false;
  return isTTY();
}

/**
 * Create the Pino logger instance
 *
 * Uses synchronous streams for both modes to ensure logs are written
 * before process exit (important for MCP servers).
 */
function createLogger(): { logger: Logger; stream: DestinationStream } {
  const level = getLogLevel();

  const baseConfig: pino.LoggerOptions = {
    name: 'mcp-server-db2i',
    level,
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: {
      paths: [...REDACT_PATHS],
      censor: REDACT_CENSOR,
    },
  };

  // Create synchronous destination to stderr
  const destination = pino.destination({ dest: 2, sync: true });

  if (usePrettyPrint()) {
    // Synchronous pretty stream (not async transport) for reliable shutdown
    const prettyStream = pretty({
      colorize: useColors(),
      translateTime: 'SYS:yyyy-mm-dd HH:MM:ss.l',
      ignore: 'pid,hostname',
      destination: destination,
      sync: true,
    });

    const logger = pino(baseConfig, prettyStream);
    return { logger, stream: destination };
  }

  // Production: JSON to stderr
  const logger = pino(baseConfig, destination);
  return { logger, stream: destination };
}

// Create logger and keep reference to stream for flushing
const { logger: _logger, stream: _stream } = createLogger();

/**
 * The singleton logger instance
 */
export const logger = _logger;

/**
 * Flush the logger stream synchronously.
 * Call this before process.exit() to ensure all logs are written.
 */
export function flushLogger(): void {
  if ('flushSync' in _stream && typeof _stream.flushSync === 'function') {
    _stream.flushSync();
  }
}

/**
 * Create a child logger with additional context
 *
 * @example
 * const dbLogger = createChildLogger({ component: 'database' });
 * dbLogger.info('Connected');
 */
export function createChildLogger(bindings: Record<string, unknown>): Logger {
  return logger.child(bindings);
}
