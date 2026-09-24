# Development Guide

This guide covers setting up a development environment and contributing to mcp-server-db2i.

## Prerequisites

- **Node.js** 22 or higher (required for `--env-file` flag)
- **Java Runtime Environment (JRE)** 11 or higher (for the default `jt400` driver; `npm install` builds the JDBC bridge)
- **unixODBC** and the **IBM i Access ODBC Driver** only if you run with `DB2I_DRIVER=odbc` (see [Database Drivers](configuration.md#database-drivers))
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
nvm use
npm install
```

`nvm use` reads `.nvmrc` and switches to Node 22. fnm and mise read the same file. `.npmrc` sets `engine-strict`, so `npm install` fails on an older Node instead of building the JDBC bridge for the wrong version. If you switch Node versions later, run `npm rebuild` so the native module matches.

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

This uses `tsx` to run TypeScript directly. It does not restart on changes.

## Available Scripts

| Script | Description |
|--------|-------------|
| `npm run dev` | Run the TypeScript source with `tsx` |
| `npm run build` | Compile TypeScript to JavaScript |
| `npm start` | Run production build |
| `npm test` | Run tests |
| `npm run test:watch` | Run tests in watch mode |
| `npm run lint` | Run ESLint |
| `npm run lint:fix` | Run ESLint with auto-fix |
| `npm run typecheck` | Type-check `src` and `tests` |

## Project Structure

```
mcp-server-db2i/
├── src/
│   ├── index.ts           # Entry point: startup checks, transports, shutdown
│   ├── cli.ts             # Command-line flags and validate-tools
│   ├── server.ts          # MCP server factory and tool registration
│   ├── systems.ts         # DB2I_PROFILES and the per-call target system
│   ├── resources.ts       # MCP resources and name completion
│   ├── prompts.ts         # MCP prompts
│   ├── config.ts          # Configuration loading
│   ├── openapi.ts         # OpenAPI specification
│   ├── auth/              # Authentication (HTTP): tokens and middleware
│   ├── db/                # Database layer
│   │   ├── connection.ts  # Connection pools per caller and system
│   │   ├── driver.ts      # Driver interface
│   │   ├── drivers/       # jt400 and odbc implementations
│   │   ├── queries.ts     # Catalog queries
│   │   ├── profile.ts     # profile_table statistics
│   │   └── sqlServices.ts # PARSE_STATEMENT, GENERATE_SQL, RELATED_OBJECTS
│   ├── customTools/       # YAML business SQL tools, annotations, masking, file watch
│   ├── tools/             # MCP tools
│   │   ├── query.ts       # execute_query
│   │   ├── sqlLimit.ts    # FETCH FIRST row cap
│   │   ├── metadata.ts    # Schema, table, and catalog search tools
│   │   ├── profile.ts     # profile_table
│   │   └── sqlServices.ts # validate_query, DDL, related objects, journals
│   ├── transports/        # HTTP transport
│   │   ├── http.ts        # Express server and /auth
│   │   ├── sessionAuth.ts # Session key per auth mode
│   │   └── sessionManager.ts
│   └── utils/
│       ├── logger.ts      # Structured logging
│       ├── auditLog.ts    # One JSON line per tool call
│       ├── formatResult.ts # json, pretty, and markdown tool text
│       ├── rateLimiter.ts # Rate limiting
│       └── security/      # SQL validation and schema allowlist
├── tests/                 # Unit and integration tests (no IBM i needed)
├── examples/              # Business SQL tools and a profiles file
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

The tests in `tests/integration/` run the MCP server end to end over an in-memory transport, with the database driver mocked. They need no IBM i connection and run as part of `npm test`. To run only them:

```bash
npm run test -- tests/integration/
```

## Validating tool files

`validate-tools` runs the startup checks on YAML tool files and then exits. It does not open a database connection and does not need `DB2I_HOSTNAME`.

```bash
npx mcp-server-db2i validate-tools examples/erp-tools
```

`QUERY_ALLOWED_SCHEMAS` and `DB2I_SCHEMA` are applied when they are set. `--connect` also runs each statement through `QSYS2.PARSE_STATEMENT` on `ibmi.example.com` (or whichever host `DB2I_HOSTNAME` names). That path needs credentials. A missing `PARSE_STATEMENT` is a failure.

```bash
npx mcp-server-db2i validate-tools --connect examples/erp-tools
```

A CI job can run the check with no secrets:

```yaml
      - name: Validate tool files
        run: npx mcp-server-db2i validate-tools examples/erp-tools
```

The command exits 0 when every file passes and 1 when any file fails.

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
import type { DbTarget } from '../systems.js';
import { createChildLogger } from '../utils/logger.js';

const log = createChildLogger({ component: 'my-tool' });

export interface MyToolInput {
  param1: string;
  param2?: number;
  target?: DbTarget;  // Caller and IBM i system; omit for the stdio default
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
    // Type-safe error handling
    const message = err instanceof Error ? err.message : String(err);
    return { success: false, error: message };
  }
}
```

2. **Add the name** to `TOOL_NAMES` in `src/config.ts`, so `MCP_TOOLS_ENABLED` and `MCP_TOOLS_DISABLED` accept it.

3. **Register the tool** in `createServer()` in `src/server.ts`. `withToolHandler` resolves the target system, applies the rate limit, writes the audit line, and formats the result:

```typescript
if (enabledTools.has('my_tool')) {
  server.registerTool(
    'my_tool',
    {
      title: 'My Tool',
      description: 'Description of what this tool does',
      annotations: READ_ONLY_ANNOTATIONS,
      inputSchema: z.object({
        ...system,
        param1: z.string().describe('First parameter'),
        param2: z.number().optional().describe('Optional second parameter'),
      }),
      outputSchema: myToolOutputSchema,
    },
    withToolHandler(
      (args, target) => myTool({ ...args, target }),
      'My tool failed',
      sessionContext,
      argsAudit('my_tool'),
    )
  );
}
```

4. **Add tests** in `tests/`:

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

The `db/connection.ts` module manages connection pools. It does not know which driver it uses: `db/driver.ts` defines the `DbPool` and `DbDriver` interfaces, and `db/drivers/jt400.ts` and `db/drivers/odbc.ts` implement them. The driver module is imported on first use, and a pool connects on its first query. `tests/db/drivers.contract.test.ts` runs both implementations against fakes.

Pools:

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

- Use a [Conventional Commits](https://www.conventionalcommits.org/) PR title (`feat:`, `fix:`, `ci:`, …). That title becomes the squash-commit subject.
- Squash-merge only. Merge commits make Release Please list the same change twice in `CHANGELOG.md`.
- Describe the changes clearly
- Reference any related issues (`Fixes #123` in the PR body)
- Ensure all tests pass
- Update documentation as needed
- Keep changes focused and atomic

## Release Process

Releases are automated via GitHub Actions using [Release Please](https://github.com/googleapis/release-please):

1. Squash-merged conventional commits on `main` are analyzed
2. A release PR is automatically created/updated with the version bump and `CHANGELOG.md`
3. Merging the release PR tags `vX.Y.Z`, creates the GitHub release, runs CI on the tagged commit, and publishes `mcp-server-db2i` to npm via OIDC trusted publishing. Other pushes to `main` only update the release PR: branch protection has already built and tested them
4. CI and npm publish both run on Node 22. Publish installs the latest npm so trusted publishing works. The registry publish retries up to 20 times, 30 seconds apart (about 10 minutes), because a just-published npm version can still 404.

To retry publishing an already-tagged release (for example after an npm outage), run the **Release** workflow with `workflow_dispatch` and set `tag` to `vX.Y.Z`. That path skips Release Please and republishes the existing tag.

`ci:` commits appear under **CI/CD** in the next version’s changelog but do not bump the version by themselves.

## Getting Help

- Open an issue for bugs or feature requests
- Check existing issues before creating new ones
- Provide reproduction steps for bugs
- Include relevant logs and configuration
