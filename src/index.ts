#!/usr/bin/env node
/**
 * IBM DB2i MCP Server
 *
 * A Model Context Protocol server for querying and inspecting
 * IBM DB2 for i (DB2i) databases using the JT400 JDBC driver.
 * 
 * Supports two transport modes:
 * - stdio (default): For CLI/IDE integration
 * - http: For web/agent integration with token authentication
 * 
 * Transport mode is controlled by MCP_TRANSPORT environment variable:
 * - 'stdio' (default): Only stdio transport
 * - 'http': Only HTTP transport
 * - 'both': Both transports simultaneously
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type http from 'node:http';
import type https from 'node:https';

import { loadConfig, isHttpEnabled, isStdioEnabled, getHttpConfig } from './config.js';
import { initializePool, testConnection, closeGlobalPool } from './db/connection.js';
import { logger, flushLogger } from './utils/logger.js';
import { getRateLimiter } from './utils/rateLimiter.js';
import { createServer, SERVER_NAME, SERVER_VERSION } from './server.js';
import { startHttpServer, shutdownHttpServer } from './transports/http.js';

/**
 * Main entry point
 */
async function main(): Promise<void> {
  let stdioServer: ReturnType<typeof createServer> | null = null;
  let httpServer: http.Server | https.Server | null = null;

  /**
   * Gracefully shutdown all servers
   */
  async function shutdown(signal: string): Promise<void> {
    logger.info(`Received ${signal}, shutting down...`);

    const shutdownPromises: Promise<void>[] = [];

    // Shutdown HTTP server if running
    if (httpServer) {
      shutdownPromises.push(
        shutdownHttpServer(httpServer).catch((err) => {
          logger.error({ err }, 'Error shutting down HTTP server');
        })
      );
    }

    // Shutdown stdio server if running
    if (stdioServer) {
      shutdownPromises.push(
        stdioServer.close().then(() => {
          logger.info('Stdio MCP server closed');
        }).catch((err) => {
          logger.error({ err }, 'Error closing stdio MCP server');
        })
      );
    }

    await Promise.all(shutdownPromises);

    // Close global DB pool (used by stdio transport)
    await closeGlobalPool();
    
    flushLogger();
    process.exit(0);
  }

  try {
    const httpConfig = getHttpConfig();
    logger.info(
      { transport: httpConfig.transport },
      'Starting MCP server...'
    );

    // Initialize rate limiter (logs its own config)
    getRateLimiter();

    // Check which transports are enabled
    const stdioEnabled = isStdioEnabled();
    const httpEnabled = isHttpEnabled();

    // For stdio mode, we need DB config from environment
    if (stdioEnabled) {
      // Load configuration from environment variables
      const config = loadConfig();
      logger.debug({ hostname: config.hostname, port: config.port }, 'Configuration loaded for stdio');

      // Initialize global database connection pool for stdio
      initializePool(config);
      logger.debug('Global database connection pool initialized');

      // Test the connection
      const connected = await testConnection();
      if (!connected) {
        logger.warn('Could not verify database connection. The server will start but queries may fail.');
      } else {
        logger.info('Database connection verified');
      }

      // Create and connect stdio MCP server
      stdioServer = createServer();
      const transport = new StdioServerTransport();
      await stdioServer.connect(transport);
      logger.info(
        { name: SERVER_NAME, version: SERVER_VERSION },
        'MCP server connected via stdio transport'
      );
    }

    // Start HTTP server if enabled
    if (httpEnabled) {
      logger.info(
        {
          port: httpConfig.port,
          host: httpConfig.host,
          sessionMode: httpConfig.sessionMode,
          tlsEnabled: httpConfig.tls.enabled,
        },
        'Starting HTTP transport...'
      );

      httpServer = await startHttpServer();
      
      logger.info(
        { name: SERVER_NAME, version: SERVER_VERSION },
        'MCP server HTTP transport started'
      );
    }

    // Log final status
    if (stdioEnabled && httpEnabled) {
      logger.info('MCP server running with both stdio and HTTP transports');
    } else if (stdioEnabled) {
      logger.info('MCP server running with stdio transport only');
    } else if (httpEnabled) {
      logger.info('MCP server running with HTTP transport only');
    }

    // Handle shutdown gracefully
    process.on('SIGINT', () => {
      shutdown('SIGINT').catch((err) => {
        logger.error({ err }, 'Error during SIGINT shutdown');
        process.exit(1);
      });
    });
    process.on('SIGTERM', () => {
      shutdown('SIGTERM').catch((err) => {
        logger.error({ err }, 'Error during SIGTERM shutdown');
        process.exit(1);
      });
    });

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
