#!/usr/bin/env node
/**
 * IBM DB2i MCP Server
 *
 * A Model Context Protocol server for querying and inspecting
 * IBM DB2 for i (DB2i) databases using the JT400 JDBC driver.
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { loadConfig } from './config.js';
import { initializePool, testConnection } from './db/connection.js';
import { logger, flushLogger } from './utils/logger.js';
import { getRateLimiter } from './utils/rateLimiter.js';
import { createServer, SERVER_NAME, SERVER_VERSION } from './server.js';

/**
 * Main entry point
 */
async function main(): Promise<void> {
  let server: ReturnType<typeof createServer> | null = null;

  /**
   * Gracefully shutdown the server
   */
  function shutdown(signal: string): void {
    logger.info(`Received ${signal}, shutting down...`);
    if (server) {
      server.close().then(() => {
        logger.info('MCP server closed');
        flushLogger();
        process.exit(0);
      }).catch((error) => {
        logger.error({ err: error }, 'Error closing MCP server');
        flushLogger();
        process.exit(1);
      });
    } else {
      flushLogger();
      process.exit(0);
    }
  }

  try {
    logger.info('Starting MCP server...');

    // Load configuration from environment variables
    const config = loadConfig();
    logger.debug({ hostname: config.hostname, port: config.port }, 'Configuration loaded');

    // Initialize database connection pool
    initializePool(config);
    logger.debug('Database connection pool initialized');

    // Test the connection
    const connected = await testConnection();
    if (!connected) {
      logger.warn('Could not verify database connection. The server will start but queries may fail.');
    } else {
      logger.info('Database connection verified');
    }

    // Initialize rate limiter (logs its own config)
    getRateLimiter();

    // Create MCP server
    server = createServer();
    logger.debug('MCP server instance created');

    // Connect via stdio transport
    const transport = new StdioServerTransport();
    await server.connect(transport);
    logger.info({ name: SERVER_NAME, version: SERVER_VERSION }, 'MCP server connected via stdio transport');

    // Handle shutdown gracefully
    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));

  } catch (error) {
    logger.fatal({ err: error }, 'Failed to start MCP server');
    flushLogger();
    process.exit(1);
  }
}

// Run the server
main().catch((error) => {
  logger.fatal({ err: error }, 'Fatal error during server startup');
  flushLogger();
  process.exit(1);
});
