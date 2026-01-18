# Development Guide

This guide covers setting up a development environment and contributing to mcp-server-db2i.

## Prerequisites

- **Node.js** 18 or higher
- **Java Runtime Environment (JRE)** 11 or higher (for JDBC)
- **npm** or **yarn**
- Access to an IBM i system (for integration testing)

## Getting Started

### 1. Clone the Repository

```bash
git clone https://github.com/Strom-Capital/mcp-server-db2i.git
cd mcp-server-db2i
```

### 2. Install Dependencies

```bash
npm install
```

### 3. Configure Environment

Create a `.env` file:

```env
DB2I_HOSTNAME=your-ibm-i-host.com
DB2I_USERNAME=your-username
DB2I_PASSWORD=your-password
DB2I_SCHEMA=your-schema

# Development settings
LOG_LEVEL=debug
LOG_PRETTY=true
```

### 4. Run in Development Mode

```bash
npm run dev
```

This uses `tsx` to run TypeScript directly with hot-reload support.

## Available Scripts

| Script | Description |
|--------|-------------|
| `npm run dev` | Run in development mode with hot-reload |
| `npm run build` | Compile TypeScript to JavaScript |
| `npm start` | Run production build |
| `npm test` | Run tests |
| `npm run test:watch` | Run tests in watch mode |
| `npm run lint` | Run ESLint |
| `npm run lint:fix` | Run ESLint with auto-fix |
| `npm run typecheck` | Run TypeScript type checking |

## Project Structure

```
mcp-server-db2i/
├── src/
│   ├── index.ts           # Entry point
│   ├── server.ts          # MCP server factory
│   ├── config.ts          # Configuration loading
│   ├── openapi.ts         # OpenAPI specification
│   ├── auth/              # Authentication (HTTP)
│   │   ├── index.ts
│   │   ├── types.ts
│   │   ├── tokenManager.ts
│   │   └── authMiddleware.ts
│   ├── db/                # Database layer
│   │   ├── connection.ts  # Connection pool management
│   │   ├── queries.ts     # Query functions
│   │   └── drivers/       # Driver implementations
│   ├── tools/             # MCP tools
│   │   ├── query.ts       # execute_query tool
│   │   └── metadata.ts    # Schema/table tools
│   ├── transports/        # Transport implementations
│   │   ├── http.ts        # HTTP/Express server
│   │   ├── sessionManager.ts
│   │   └── index.ts
│   └── utils/             # Utilities
│       ├── logger.ts      # Structured logging
│       ├── rateLimiter.ts # Rate limiting
│       └── security/      # SQL validation
├── tests/                 # Test files
├── docs/                  # Documentation
├── Dockerfile
├── docker-compose.yml
├── package.json
├── tsconfig.json
└── vitest.config.ts
```

## Testing

### Run All Tests

```bash
npm test
```

### Watch Mode

```bash
npm run test:watch
```

### Test Coverage

```bash
npm run test -- --coverage
```

### Integration Tests

Integration tests require a real IBM i connection. Set environment variables and run:

```bash
npm run test -- tests/integration/
```

## Code Style

The project uses ESLint with TypeScript rules. Format code before committing:

```bash
npm run lint:fix
```

### Conventions

- Use TypeScript strict mode
- Prefer `async`/`await` over callbacks
- Use structured logging with `createChildLogger`
- Document public functions with JSDoc comments
- Keep functions focused and testable

## Adding a New Tool

1. **Create the tool function** in `src/tools/`:

```typescript
// src/tools/myTool.ts
import { createChildLogger } from '../utils/logger.js';

const log = createChildLogger({ component: 'my-tool' });

export interface MyToolInput {
  param1: string;
  param2?: number;
  sessionId?: string;  // For HTTP transport
}

export async function myTool(input: MyToolInput): Promise<{
  success: boolean;
  data?: unknown;
  error?: string;
}> {
  log.debug({ input }, 'Executing myTool');
  
  try {
    // Implementation
    return { success: true, data: result };
  } catch (err) {
    log.error({ err }, 'myTool failed');
    return { success: false, error: err.message };
  }
}
```

2. **Register the tool** in `src/server.ts`:

```typescript
import { myTool } from './tools/myTool.js';

// In createServer():
server.registerTool(
  'my_tool',
  {
    title: 'My Tool',
    description: 'Description of what this tool does',
    annotations: { readOnlyHint: true },
    inputSchema: {
      param1: z.string().describe('First parameter'),
      param2: z.number().optional().describe('Optional second parameter'),
    },
  },
  withToolHandler(
    (args, sessionId) => myTool({ ...args, sessionId }),
    'My tool failed',
    sessionContext
  )
);
```

3. **Add tests** in `tests/`:

```typescript
// tests/myTool.test.ts
import { describe, it, expect } from 'vitest';
import { myTool } from '../src/tools/myTool.js';

describe('myTool', () => {
  it('should return success for valid input', async () => {
    const result = await myTool({ param1: 'test' });
    expect(result.success).toBe(true);
  });
});
```

## Database Layer

### Connection Pool

The `db/connection.ts` module manages JDBC connection pools:

- **Global pool**: For stdio transport
- **Session pools**: For HTTP transport (per-authenticated user)

```typescript
// Global pool (stdio)
initializePool(config);
const result = await executeQuery(sql, params);

// Session pool (HTTP)
initializeSessionPool(sessionId, config);
const result = await executeQuery(sql, params, sessionId);
closeSessionPool(sessionId);
```

### Adding Queries

Add new query functions in `src/db/queries.ts`:

```typescript
export async function myQuery(
  param: string,
  sessionId?: string
): Promise<MyResult[]> {
  const sql = `
    SELECT COLUMN1, COLUMN2
    FROM QSYS2.MY_VIEW
    WHERE FIELD = ?
  `;
  
  const result = await executeQuery(sql, [param], sessionId);
  return result.rows.map(row => ({
    column1: String(row.COLUMN1 || '').trim(),
    column2: Number(row.COLUMN2 || 0),
  }));
}
```

## HTTP Transport

### Adding Endpoints

Add routes in `src/transports/http.ts`:

```typescript
app.get('/my-endpoint', authMiddleware, async (req, res) => {
  // Implementation
  res.json({ status: 'ok' });
});
```

### Authentication

HTTP endpoints use Bearer token authentication:

```typescript
import { authMiddleware, AuthenticatedRequest } from '../auth/index.js';

app.get('/protected', authMiddleware, (req, res) => {
  const authReq = req as AuthenticatedRequest;
  const session = authReq.tokenSession;
  // Use session.config for DB operations
});
```

## Debugging

### Enable Debug Logging

```bash
LOG_LEVEL=debug npm run dev
```

### VS Code Launch Configuration

Create `.vscode/launch.json`:

```json
{
  "version": "0.2.0",
  "configurations": [
    {
      "type": "node",
      "request": "launch",
      "name": "Debug",
      "runtimeExecutable": "npx",
      "runtimeArgs": ["tsx", "src/index.ts"],
      "envFile": "${workspaceFolder}/.env",
      "console": "integratedTerminal"
    }
  ]
}
```

## Contributing

### 1. Fork the Repository

Fork on GitHub and clone your fork:

```bash
git clone https://github.com/YOUR-USERNAME/mcp-server-db2i.git
```

### 2. Create a Branch

```bash
git checkout -b feature/my-feature
```

### 3. Make Changes

- Write code
- Add tests
- Update documentation if needed
- Run lint and tests

### 4. Commit

Follow conventional commit format:

```bash
git commit -m "feat: add new tool for X"
git commit -m "fix: handle edge case in Y"
git commit -m "docs: update configuration guide"
```

### 5. Push and Create PR

```bash
git push origin feature/my-feature
```

Then create a Pull Request on GitHub.

### Pull Request Guidelines

- Describe the changes clearly
- Reference any related issues
- Ensure all tests pass
- Update documentation as needed
- Keep changes focused and atomic

## Release Process

Releases are automated via GitHub Actions using Release Please:

1. Commits to `main` are analyzed
2. A release PR is automatically created/updated
3. Merging the release PR triggers:
   - Version bump
   - Changelog update
   - npm publish
   - GitHub release

## Getting Help

- Open an issue for bugs or feature requests
- Check existing issues before creating new ones
- Provide reproduction steps for bugs
- Include relevant logs and configuration
