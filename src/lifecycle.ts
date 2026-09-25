/**
 * Server shutdown.
 *
 * Shutdown runs once, whatever starts it: a signal, or the stdio client going
 * away. It is capped by a deadline, because closing a pool waits for a running
 * statement, and the process must never outlive its client for that reason.
 */

import { stopCustomToolsWatch } from './customTools/watch.js';
import { closeAuditLog, writeAuditEvent } from './utils/auditLog.js';
import { createChildLogger, flushLogger } from './utils/logger.js';

const log = createChildLogger({ component: 'lifecycle' });

/** How long shutdown may take before the process exits with pools still open. */
export const SHUTDOWN_DEADLINE_MS = 5000;

export type ShutdownReason = 'SIGINT' | 'SIGTERM' | 'SIGHUP' | 'stdin closed';

export interface LifecycleOptions {
  /** HTTP is enabled, so the process outlives the stdio client (`MCP_TRANSPORT=both`). */
  httpEnabled: boolean;
  /** Close the stdio pools on every system. */
  closeStdioPools: () => Promise<void>;
  /** Pools still closing, named in the deadline warning. */
  pendingPools: () => string[];
  /** Ends the process. `process.exit` outside tests. */
  exit: (code: number) => void;
  deadlineMs?: number;
}

export interface Lifecycle {
  /** Register the stdio transport's close, once it is serving. */
  setStdio(close: () => Promise<void>): void;
  /** Register the HTTP transport's close, once it is listening. */
  setHttp(close: () => Promise<void>): void;
  /** Shut everything down and exit. Later calls return the first call's promise. Never rejects. */
  shutdown(reason: ShutdownReason): Promise<void>;
  /**
   * The stdio transport closed. With HTTP enabled, only the stdio side ends;
   * otherwise the server shuts down.
   */
  onStdioClientGone(): void;
}

/**
 * Create the shutdown coordinator for one server process.
 */
export function createLifecycle(options: LifecycleOptions): Lifecycle {
  const deadlineMs = options.deadlineMs ?? SHUTDOWN_DEADLINE_MS;
  let closeStdio: (() => Promise<void>) | undefined;
  let closeHttp: (() => Promise<void>) | undefined;
  let running: Promise<void> | undefined;
  let stopping = false;
  let exited = false;
  let stdioGone = false;

  function finish(code: number): void {
    if (exited) {
      return;
    }
    exited = true;
    closeAuditLog();
    flushLogger();
    options.exit(code);
  }

  async function run(reason: ShutdownReason): Promise<void> {
    log.info({ reason }, 'Shutting down');
    writeAuditEvent({ event: 'shutdown', reason });
    stopCustomToolsWatch();

    const deadline = setTimeout(() => {
      log.warn(
        { pendingPools: options.pendingPools(), deadlineMs },
        'Shutdown deadline reached; exiting with pools still open'
      );
      writeAuditEvent({ event: 'shutdown', reason: 'deadline' });
      finish(1);
    }, deadlineMs);

    try {
      const closing: Promise<void>[] = [];
      if (closeHttp) {
        closing.push(
          closeHttp().catch((err: unknown) => {
            log.error({ err }, 'Error shutting down HTTP server');
          })
        );
      }
      if (closeStdio) {
        closing.push(
          closeStdio().then(() => {
            log.info('Stdio MCP server closed');
          }).catch((err: unknown) => {
            log.error({ err }, 'Error closing stdio MCP server');
          })
        );
      }
      await Promise.all(closing);
      await options.closeStdioPools();
      clearTimeout(deadline);
      finish(0);
    } catch (err) {
      clearTimeout(deadline);
      log.error({ err, reason }, 'Error during shutdown');
      finish(1);
    }
  }

  function shutdown(reason: ShutdownReason): Promise<void> {
    if (!running) {
      // Set before run() starts: closing the transport can report the client gone synchronously
      stopping = true;
      running = run(reason);
    }
    return running;
  }

  return {
    setStdio(close) {
      closeStdio = close;
    },
    setHttp(close) {
      closeHttp = close;
    },
    shutdown,
    onStdioClientGone() {
      // Shutdown closes the transport too, which lands here
      if (stopping || stdioGone) {
        return;
      }
      if (!options.httpEnabled) {
        void shutdown('stdin closed');
        return;
      }
      stdioGone = true;
      closeStdio = undefined;
      log.info('Stdio client went away; HTTP transport keeps running');
      options.closeStdioPools().catch((err: unknown) => {
        log.error({ err }, 'Error closing stdio connection pools');
      });
    },
  };
}
