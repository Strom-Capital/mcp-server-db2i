/**
 * The server's name and version, read from package.json so they follow npm releases.
 * Shared by the MCP handshake, the OpenAPI document and the audit log.
 */

import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const packageJson = require('../package.json') as { name: string; version: string };

export const SERVER_NAME = packageJson.name;
export const SERVER_VERSION = packageJson.version;
