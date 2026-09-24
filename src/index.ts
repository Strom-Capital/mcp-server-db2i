#!/usr/bin/env node
/**
 * IBM DB2i MCP Server
 *
 * A Model Context Protocol server for querying and inspecting
 * IBM DB2 for i (DB2i) databases through JT400 (JDBC) or IBM i Access ODBC,
 * on one or more IBM i systems (DB2I_PROFILES).
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

import { serveStdio, type StdioServerHandle } from '@modelcontextprotocol/server/stdio';
import type http from 'node:http';
import type https from 'node:https';

import {
  isHttpEnabled,
  isStdioEnabled,
  getTransportMode,
  getHttpConfig,
  getEnabledTools,
  getResponseFormat,
  connectionSecurity,
  assertCustomToolsWatch,
  isCustomToolsWatchEnabled,
  isQueryParseCheckEnabled,
  getQueryLimitConfig,
} from './config.js';
import { initializePool, testConnection, closeGlobalPool } from './db/connection.js';
import { defaultSystem, getSystems, isProfilesFileConfigured, type SystemProfile } from './systems.js';
import { logger, flushLogger } from './utils/logger.js';
import { getRateLimiter } from './utils/rateLimiter.js';
import { createServer, pinStdioServer, SERVER_NAME, SERVER_VERSION } from './server.js';
import { startCustomToolsWatch, stopCustomToolsWatch } from './customTools/watch.js';
import { parseCliArgs, runValidateTools } from './cli.js';
import { loadCustomToolsFromEnv } from './customTools/loader.js';
import { closeAuditLog, initAuditLog } from './utils/auditLog.js';
import { setCustomTools } from './customTools/registry.js';
import { startHttpServer, shutdownHttpServer } from './transports/http.js';

/**
 * Main entry point
 */
async function main(): Promise<void> {
  let stdioServer: StdioServerHandle | null = null;
  let httpServer: http.Server | https.Server | null = null;

  /**
   * Gracefully shutdown all servers
   */
  async function shutdown(signal: string): Promise<void> {
    logger.info(`Received ${signal}, shutting down...`);
    stopCustomToolsWatch();
    closeAuditLog();

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
    const transportMode = getTransportMode();
    logger.info(
      { transport: transportMode },
      'Starting MCP server...'
    );

    // Initialize rate limiter (logs its own config)
    getRateLimiter();
    // Fail on a malformed QUERY_DEFAULT_LIMIT / QUERY_MAX_LIMIT now, not on the first query
    getQueryLimitConfig();

    // Reads and checks DB2I_PROFILES, so a bad file stops startup
    const systems = getSystems();
    const profiles = isProfilesFileConfigured();
    if (profiles) {
      logger.info(
        { systems: systems.map((system) => ({ name: system.name, host: system.config.hostname, driver: system.config.driver })) },
        'IBM i systems loaded from DB2I_PROFILES'
      );
    }
    for (const system of systems) {
      warnConnectionSecurity(system, profiles);
    }

    // Validates tool files and MCP_TOOLS_ENABLED / MCP_TOOLS_DISABLED before any transport starts
    const customTools = loadCustomToolsFromEnv();
    assertCustomToolsWatch();
    if (customTools.masking.size > 0 && !isQueryParseCheckEnabled()) {
      logger.warn(
        'Masking rules are loaded and QUERY_PARSE_CHECK is off. execute_query will refuse to run until the check is on.'
      );
    }
    initAuditLog();
    setCustomTools(customTools);
    const enabledTools = getEnabledTools(customTools.tools);
    if (enabledTools.length === 0) {
      logger.warn('All tools are disabled by MCP_TOOLS_ENABLED / MCP_TOOLS_DISABLED');
    }
    logger.info(
      {
        tools: enabledTools,
        customTools: customTools.tools.length,
        annotations: customTools.annotations.length,
        responseFormat: getResponseFormat(),
      },
      'Tool configuration loaded'
    );
    if (isCustomToolsWatchEnabled()) {
      startCustomToolsWatch();
      logger.info('Watching custom tool files for changes');
    }

    // Check which transports are enabled
    const stdioEnabled = isStdioEnabled();
    const httpEnabled = isHttpEnabled();

    // For stdio mode, the default system's connection settings are required
    if (stdioEnabled) {
      const system = defaultSystem();
      const { config } = system;
      logger.debug({ hostname: config.hostname, port: config.port, system: system.name }, 'Configuration loaded for stdio');

      // Register the stdio pools. Other systems connect on their first query.
      initializePool(config, system.name);

      // Test the default system's connection
      const connected = await testConnection();
      if (!connected) {
        logger.warn('Could not verify database connection. The server will start but queries may fail.');
      } else {
        logger.info('Database connection verified');
      }

      // serveStdio pins one server per connection and speaks both 2025 and 2026-07-28
      stdioServer = serveStdio(() => {
        const server = createServer();
        const release = pinStdioServer(server);
        const close = server.close.bind(server);
        server.close = () => {
          release();
          return close();
        };
        return server;
      });
      logger.info(
        { name: SERVER_NAME, version: SERVER_VERSION },
        'MCP server connected via stdio transport'
      );
    }

    // Start HTTP server if enabled
    // Note: getHttpConfig() is called here (not at startup) to avoid validating
    // HTTP-specific settings when only stdio transport is being used
    if (httpEnabled) {
      const httpConfig = getHttpConfig();
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

/**
 * Log the driver, and warn when a system's options turn off read only or TLS.
 */
function warnConnectionSecurity(system: SystemProfile, profiles: boolean): void {
  const security = profiles
    ? connectionSecurity(
        system.config.driver,
        system.config.driver === 'odbc' ? system.config.odbcOptions : system.config.jdbcOptions
      )
    : connectionSecurity();
  const optionsVariable = profiles
    ? `Profile ${system.name} ${security.driver === 'odbc' ? 'odbcOptions' : 'jdbcOptions'}`
    : security.optionsVariable;
  const context = profiles ? { system: system.name } : {};

  logger.info({ ...context, driver: security.driver }, 'Database driver selected');
  if (security.accessOverride !== undefined) {
    logger.warn(
      { ...context, access: security.accessOverride },
      `${optionsVariable} sets ${security.driver === 'odbc' ? 'CONNTYPE' : 'access'} and overrides the read only default`
    );
  }
  if (!security.secure) {
    logger.warn(
      context,
      `Database connection is not using TLS. Set ${security.secureHint} in ${optionsVariable} after the IBM i host servers are configured for SSL.`
    );
  }
}

const command = parseCliArgs(process.argv.slice(2));
if (command.kind === 'serve') {
  main().catch((error) => {
    logger.fatal({ err: error }, 'Fatal error during server startup');
    flushLogger();
    process.exit(1);
  });
} else if (command.kind === 'usage') {
  process.stderr.write(`${command.message}\n`);
  flushLogger();
  process.exit(1);
} else {
  runValidateTools(command).then((code) => {
    flushLogger();
    process.exit(code);
  }).catch((error) => {
    logger.fatal({ err: error }, 'validate-tools failed');
    flushLogger();
    process.exit(1);
  });
}
