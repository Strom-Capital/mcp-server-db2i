/**
 * OpenAPI 3.1 Specification for IBM Db2i MCP Server HTTP Transport
 *
 * Provides machine-readable API documentation for:
 * - Authentication endpoint (/auth)
 * - Health check endpoint (/health)
 * - MCP protocol endpoints (/mcp)
 *
 * Can be imported into Postman, Insomnia, or other API clients.
 */

import { SERVER_NAME, SERVER_VERSION } from './server.js';

/**
 * OpenAPI 3.1 specification type
 */
export interface OpenApiSpec {
  openapi: string;
  info: {
    title: string;
    version: string;
    description: string;
    license?: { name: string; url: string };
    contact?: { url: string };
  };
  servers?: Array<{ url: string; description: string }>;
  tags?: Array<{ name: string; description: string }>;
  paths: Record<string, unknown>;
  components?: {
    securitySchemes?: Record<string, unknown>;
    schemas?: Record<string, unknown>;
  };
}

/**
 * Generate the OpenAPI specification
 *
 * @param baseUrl - Optional base URL for the server (defaults to relative paths)
 * @returns OpenAPI 3.1 specification object
 */
export function getOpenApiSpec(baseUrl?: string): OpenApiSpec {
  return {
    openapi: '3.1.0',
    info: {
      title: SERVER_NAME,
      version: SERVER_VERSION,
      description:
        'IBM Db2 for i MCP Server HTTP API. Provides MCP protocol access for querying and inspecting Db2i databases.\n\n' +
        '## Authentication Modes\n\n' +
        'The server supports three authentication modes (configured via `MCP_AUTH_MODE`):\n\n' +
        '- **required** (default): Full `/auth` flow with per-user DB credentials. Most secure.\n' +
        '- **token**: Pre-shared static token via `MCP_AUTH_TOKEN`. Uses environment DB credentials.\n' +
        '- **none**: No authentication required. Uses environment DB credentials. For trusted networks only.\n\n' +
        'Check `/health` endpoint to see the current auth mode.',
      license: {
        name: 'MIT',
        url: 'https://opensource.org/licenses/MIT',
      },
      contact: {
        url: 'https://github.com/Strom-Capital/mcp-server-db2i',
      },
    },
    servers: baseUrl
      ? [{ url: baseUrl, description: 'MCP Server' }]
      : [{ url: '/', description: 'Current server' }],
    tags: [
      { name: 'auth', description: 'Authentication endpoints' },
      { name: 'health', description: 'Health check endpoints' },
      { name: 'mcp', description: 'MCP protocol endpoints' },
    ],
    paths: {
      '/health': {
        get: {
          tags: ['health'],
          summary: 'Health check',
          description:
            'Returns server health status and session statistics. No authentication required.',
          operationId: 'healthCheck',
          responses: {
            '200': {
              description: 'Server is healthy',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/HealthResponse' },
                },
              },
            },
          },
        },
      },
      '/auth': {
        post: {
          tags: ['auth'],
          summary: 'Authenticate and get token',
          description:
            'Exchange IBM i credentials for a Bearer token. The token is used for subsequent MCP requests. Rate limited to prevent brute force attacks.\n\n' +
            '**Note:** This endpoint is only active when `MCP_AUTH_MODE=required`. In `token` or `none` modes, this endpoint returns 404.',
          operationId: 'authenticate',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/AuthRequest' },
                example: {
                  username: 'MYUSER',
                  password: 'mypassword',
                  host: 'ibmi.example.com',
                  schema: 'MYLIB',
                },
              },
            },
          },
          responses: {
            '201': {
              description: 'Authentication successful',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/AuthResponse' },
                },
              },
            },
            '400': {
              description: 'Invalid request',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/AuthErrorResponse' },
                  example: {
                    error: 'invalid_request',
                    error_description: 'username is required and must be a non-empty string',
                  },
                },
              },
            },
            '401': {
              description: 'Authentication failed',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/AuthErrorResponse' },
                  example: {
                    error: 'invalid_credentials',
                    error_description: 'Authentication failed: unable to connect to database',
                  },
                },
              },
            },
            '404': {
              description: 'Endpoint not available (auth mode is not "required")',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/AuthErrorResponse' },
                  example: {
                    error: 'not_found',
                    error_description: 'Authentication is disabled. Access /mcp directly.',
                  },
                },
              },
            },
            '429': {
              description: 'Rate limit exceeded',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/AuthErrorResponse' },
                  example: {
                    error: 'rate_limit_exceeded',
                    error_description: 'Too many authentication attempts. Please try again later.',
                  },
                },
              },
            },
            '503': {
              description: 'Service unavailable',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/AuthErrorResponse' },
                  example: {
                    error: 'service_unavailable',
                    error_description: 'Maximum concurrent sessions reached. Please try again later.',
                  },
                },
              },
            },
          },
        },
      },
      '/mcp': {
        post: {
          tags: ['mcp'],
          summary: 'MCP JSON-RPC request',
          description:
            'Send MCP JSON-RPC 2.0 requests.\n\n' +
            '**2026-07-28:** each request carries a `_meta` envelope plus `MCP-Protocol-Version` and `Mcp-Method` (and `Mcp-Name` for a named tool call). There is no `initialize` handshake and no `Mcp-Session-Id`. Use `server/discover` to read server capabilities.\n\n' +
            '**2025-era (default stateless):** send `initialize` and later calls as separate requests. Do not send `Mcp-Session-Id`. `GET` and `DELETE` answer 405.\n\n' +
            '**Deprecated stateful mode** (`MCP_SESSION_MODE=stateful`): 2025-era clients send `initialize` without `Mcp-Session-Id`, then repeat that header. 2026-07-28 requests on the same URL stay stateless.\n\n' +
            '**Authentication:** Required in `required` and `token` modes. Not required in `none` mode. Check `/health` for current mode.\n\n' +
            '**Important:** The `Accept` header must include both `application/json` and `text/event-stream`.',
          operationId: 'mcpRequest',
          security: [{ bearerAuth: [] }, {}],
          parameters: [
            {
              name: 'Accept',
              in: 'header',
              description:
                'Must accept both application/json and text/event-stream (required by MCP protocol)',
              required: true,
              schema: { type: 'string', default: 'application/json, text/event-stream' },
              example: 'application/json, text/event-stream',
            },
            {
              name: 'MCP-Protocol-Version',
              in: 'header',
              description:
                'Required for 2026-07-28 requests. Must match `_meta["io.modelcontextprotocol/protocolVersion"]`. Omit for 2025-era requests.',
              required: false,
              schema: { type: 'string', example: '2026-07-28' },
            },
            {
              name: 'Mcp-Method',
              in: 'header',
              description:
                'Required for 2026-07-28 requests. Must match the JSON-RPC method (for example `server/discover` or `tools/call`).',
              required: false,
              schema: { type: 'string', example: 'tools/call' },
            },
            {
              name: 'Mcp-Name',
              in: 'header',
              description: 'Required for 2026-07-28 calls that name a tool, prompt, or resource.',
              required: false,
              schema: { type: 'string', example: 'execute_query' },
            },
            {
              name: 'Mcp-Session-Id',
              in: 'header',
              description:
                'Deprecated. Only used when MCP_SESSION_MODE=stateful for 2025-era clients. Omit it for 2026-07-28 and for the default stateless mode.',
              required: false,
              schema: { type: 'string' },
            },
          ],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/JsonRpcRequest' },
                examples: {
                  discover: {
                    summary: 'Discover server (2026-07-28)',
                    value: {
                      jsonrpc: '2.0',
                      method: 'server/discover',
                      params: {
                        _meta: {
                          'io.modelcontextprotocol/protocolVersion': '2026-07-28',
                          'io.modelcontextprotocol/clientInfo': { name: 'my-client', version: '1.0.0' },
                          'io.modelcontextprotocol/clientCapabilities': {},
                        },
                      },
                      id: 1,
                    },
                  },
                  initialize: {
                    summary: 'Initialize (2025-era, stateless)',
                    value: {
                      jsonrpc: '2.0',
                      method: 'initialize',
                      params: {
                        protocolVersion: '2025-06-18',
                        capabilities: {},
                        clientInfo: { name: 'my-client', version: '1.0.0' },
                      },
                      id: 1,
                    },
                  },
                  listTools: {
                    summary: 'List available tools',
                    value: {
                      jsonrpc: '2.0',
                      method: 'tools/list',
                      params: {},
                      id: 2,
                    },
                  },
                  callTool: {
                    summary: 'Call a tool',
                    value: {
                      jsonrpc: '2.0',
                      method: 'tools/call',
                      params: {
                        name: 'list_schemas',
                        arguments: { filter: 'QSYS*' },
                      },
                      id: 3,
                    },
                  },
                },
              },
            },
          },
          responses: {
            '200': {
              description: 'MCP response',
              headers: {
                'Mcp-Session-Id': {
                  description: 'Deprecated. Returned only when MCP_SESSION_MODE=stateful.',
                  schema: { type: 'string' },
                },
              },
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/JsonRpcResponse' },
                },
              },
            },
            '400': {
              description: 'Invalid request',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/JsonRpcError' },
                },
              },
            },
            '401': {
              description: 'Unauthorized',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/AuthErrorResponse' },
                },
              },
            },
            '404': {
              description: 'Session not found',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/JsonRpcError' },
                },
              },
            },
          },
        },
        get: {
          tags: ['mcp'],
          summary: 'MCP SSE stream',
          description:
            'Open Server-Sent Events stream for receiving MCP notifications. Only available in stateful session mode.\n\n' +
            '**Authentication:** Required in `required` and `token` modes. Not required in `none` mode.\n\n' +
            '**Important:** The `Accept` header must include both `application/json` and `text/event-stream`.',
          operationId: 'mcpStream',
          security: [{ bearerAuth: [] }, {}],
          parameters: [
            {
              name: 'Accept',
              in: 'header',
              description:
                'Must accept both application/json and text/event-stream (required by MCP protocol)',
              required: true,
              schema: { type: 'string', default: 'application/json, text/event-stream' },
              example: 'application/json, text/event-stream',
            },
            {
              name: 'Mcp-Session-Id',
              in: 'header',
              description: 'MCP session ID (required)',
              required: true,
              schema: { type: 'string' },
            },
          ],
          responses: {
            '200': {
              description: 'SSE stream opened',
              content: {
                'text/event-stream': {
                  schema: { type: 'string' },
                },
              },
            },
            '400': {
              description: 'Session ID required',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/AuthErrorResponse' },
                },
              },
            },
            '401': {
              description: 'Unauthorized',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/AuthErrorResponse' },
                },
              },
            },
            '404': {
              description: 'Session not found',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/AuthErrorResponse' },
                },
              },
            },
            '405': {
              description: 'Method not allowed (stateless mode)',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/AuthErrorResponse' },
                },
              },
            },
          },
        },
        delete: {
          tags: ['mcp'],
          summary: 'Close MCP session',
          description:
            'Close an MCP session and release associated resources.\n\n' +
            '**Authentication:** Required in `required` and `token` modes. Not required in `none` mode.',
          operationId: 'mcpClose',
          security: [{ bearerAuth: [] }, {}],
          parameters: [
            {
              name: 'Mcp-Session-Id',
              in: 'header',
              description: 'MCP session ID to close',
              required: true,
              schema: { type: 'string' },
            },
          ],
          responses: {
            '200': {
              description: 'Session closed',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      status: { type: 'string', example: 'session_closed' },
                      sessionId: { type: 'string' },
                    },
                  },
                },
              },
            },
            '400': {
              description: 'Session ID required',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/AuthErrorResponse' },
                },
              },
            },
            '401': {
              description: 'Unauthorized',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/AuthErrorResponse' },
                },
              },
            },
            '404': {
              description: 'Session not found',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/AuthErrorResponse' },
                },
              },
            },
          },
        },
      },
    },
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          description: 'Bearer token obtained from POST /auth',
        },
      },
      schemas: {
        AuthRequest: {
          type: 'object',
          required: ['username', 'password'],
          properties: {
            username: {
              type: 'string',
              description: 'IBM i username',
              example: 'MYUSER',
            },
            password: {
              type: 'string',
              format: 'password',
              description: 'IBM i password',
            },
            system: {
              type: 'string',
              description: 'Profile name from DB2I_PROFILES (default: the first profile). The token is bound to this system. Cannot be combined with host, port, or database.',
              example: 'prod',
            },
            host: {
              type: 'string',
              description: 'IBM i hostname (falls back to DB2I_HOSTNAME env var). Not accepted when DB2I_PROFILES is set.',
              example: 'ibmi.example.com',
            },
            port: {
              type: 'integer',
              minimum: 1,
              maximum: 65535,
              description: 'Accepted for compatibility. Not used by either driver.',
            },
            database: {
              type: 'string',
              description: 'Accepted for compatibility. Not used by either driver.',
            },
            schema: {
              type: 'string',
              description: 'Default schema (falls back to DB2I_SCHEMA, or the profile schema with DB2I_PROFILES)',
              example: 'MYLIB',
            },
            duration: {
              type: 'integer',
              minimum: 1,
              maximum: 86400,
              description: 'Token lifetime in seconds. Defaults to and is capped at MCP_TOKEN_EXPIRY (3600 unless configured).',
              example: 3600,
            },
          },
        },
        AuthResponse: {
          type: 'object',
          required: ['access_token', 'token_type', 'expires_in', 'expires_at'],
          properties: {
            access_token: {
              type: 'string',
              description: 'Bearer token for subsequent requests',
            },
            token_type: {
              type: 'string',
              enum: ['Bearer'],
              description: 'Token type (always "Bearer")',
            },
            expires_in: {
              type: 'integer',
              description: 'Token lifetime in seconds',
              example: 3600,
            },
            expires_at: {
              type: 'string',
              format: 'date-time',
              description: 'ISO 8601 timestamp of when the token expires',
            },
          },
        },
        AuthErrorResponse: {
          type: 'object',
          required: ['error'],
          properties: {
            error: {
              type: 'string',
              description: 'Error code',
              example: 'invalid_request',
            },
            error_description: {
              type: 'string',
              description: 'Human-readable error description',
            },
          },
        },
        HealthResponse: {
          type: 'object',
          required: ['status', 'timestamp', 'server', 'config', 'sessions'],
          properties: {
            status: {
              type: 'string',
              enum: ['ok'],
              description: 'Server status',
            },
            timestamp: {
              type: 'string',
              format: 'date-time',
              description: 'Current server time',
            },
            server: {
              type: 'object',
              properties: {
                name: { type: 'string', description: 'Server name' },
                version: { type: 'string', description: 'Server version' },
              },
            },
            config: {
              type: 'object',
              description: 'Server configuration',
              properties: {
                authMode: {
                  type: 'string',
                  enum: ['required', 'token', 'none'],
                  description: 'Authentication mode',
                },
                sessionMode: {
                  type: 'string',
                  enum: ['stateful', 'stateless'],
                  description: 'Session mode',
                },
                tlsEnabled: {
                  type: 'boolean',
                  description: 'Whether TLS is enabled',
                },
              },
            },
            sessions: {
              type: 'object',
              properties: {
                tokens: {
                  type: 'object',
                  description: 'Token session statistics (only in required auth mode)',
                },
                mcp: {
                  type: 'object',
                  description: 'MCP session statistics',
                },
              },
            },
          },
        },
        JsonRpcRequest: {
          type: 'object',
          required: ['jsonrpc', 'method', 'id'],
          properties: {
            jsonrpc: {
              type: 'string',
              enum: ['2.0'],
              description: 'JSON-RPC version',
            },
            method: {
              type: 'string',
              description: 'MCP method name',
              examples: ['initialize', 'tools/list', 'tools/call'],
            },
            params: {
              type: 'object',
              description: 'Method parameters',
            },
            id: {
              oneOf: [{ type: 'string' }, { type: 'integer' }],
              description: 'Request ID',
            },
          },
        },
        JsonRpcResponse: {
          type: 'object',
          required: ['jsonrpc', 'id'],
          properties: {
            jsonrpc: {
              type: 'string',
              enum: ['2.0'],
              description: 'JSON-RPC version',
            },
            result: {
              description: 'Response result (present on success)',
            },
            error: {
              $ref: '#/components/schemas/JsonRpcErrorObject',
              description: 'Error object (present on failure)',
            },
            id: {
              oneOf: [{ type: 'string' }, { type: 'integer' }, { type: 'null' }],
              description: 'Request ID',
            },
          },
        },
        JsonRpcError: {
          type: 'object',
          required: ['jsonrpc', 'error', 'id'],
          properties: {
            jsonrpc: {
              type: 'string',
              enum: ['2.0'],
            },
            error: {
              $ref: '#/components/schemas/JsonRpcErrorObject',
            },
            id: {
              oneOf: [{ type: 'string' }, { type: 'integer' }, { type: 'null' }],
            },
          },
        },
        JsonRpcErrorObject: {
          type: 'object',
          required: ['code', 'message'],
          properties: {
            code: {
              type: 'integer',
              description: 'Error code',
            },
            message: {
              type: 'string',
              description: 'Error message',
            },
            data: {
              description: 'Additional error data',
            },
          },
        },
      },
    },
  };
}
