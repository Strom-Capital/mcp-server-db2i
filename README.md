# mcp-server-db2i

A [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) server for IBM DB2 for i (DB2i). This server enables AI assistants like Claude and Cursor to query and inspect IBM i databases using the JT400 JDBC driver.

## Features

- **Read-only SQL queries** - Execute SELECT statements safely with automatic result limiting
- **Schema inspection** - List all schemas/libraries with optional filtering
- **Table metadata** - List tables, describe columns, view indexes and constraints
- **View inspection** - List and explore database views
- **Secure by design** - Only SELECT queries allowed, credentials via environment variables
- **Docker support** - Run as a container for easy deployment

## Available Tools

| Tool | Description |
|------|-------------|
| `execute_query` | Execute read-only SELECT queries |
| `list_schemas` | List schemas/libraries (with optional filter) |
| `list_tables` | List tables in a schema (with optional filter) |
| `describe_table` | Get detailed column information |
| `list_views` | List views in a schema (with optional filter) |
| `list_indexes` | List SQL indexes for a table |
| `get_table_constraints` | Get primary keys, foreign keys, unique constraints |

> **Note:** `list_indexes` and `get_table_constraints` query the `QSYS2` SQL catalog views and only return SQL-defined objects. Legacy DDS Logical Files and Physical File constraints are not included. This is standard DB2 for i behavior.

### Filter Syntax

The list tools support pattern matching:
- `CUST` - Contains "CUST"
- `CUST*` - Starts with "CUST"
- `*LOG` - Ends with "LOG"
- `ORD*FILE` - Starts with "ORD", ends with "FILE"

## Installation

### Prerequisites

- Node.js 18 or higher
- Java Runtime Environment (JRE) 11 or higher (for JDBC)
- Access to an IBM i system

### Option 1: npm (recommended)

```bash
npm install -g mcp-server-db2i
```

### Option 2: From source

```bash
git clone https://github.com/Strom-Capital/mcp-server-db2i.git
cd mcp-server-db2i
npm install
npm run build
```

### Option 3: Docker

```bash
docker build -t mcp-server-db2i .
```

## Configuration

Create a `.env` file or set environment variables:

```env
# Required
DB2I_HOSTNAME=your-ibm-i-host.com
DB2I_USERNAME=your-username
DB2I_PASSWORD=your-password

# Optional - Database
DB2I_PORT=446                              # Default: 446
DB2I_DATABASE=*LOCAL                       # Default: *LOCAL
DB2I_SCHEMA=your-default-schema            # Default schema for all tools (can be overridden per-call)
DB2I_JDBC_OPTIONS=naming=system;date format=iso

# Optional - Logging
LOG_LEVEL=info                             # debug, info, warn, error, fatal (default: info)
NODE_ENV=production                        # production = JSON logs, development = pretty logs
LOG_PRETTY=true                            # Override: force pretty (true) or JSON (false) logs
LOG_COLORS=true                            # Override: force colors on/off (auto-detected by default)

# Optional - Rate Limiting
RATE_LIMIT_WINDOW_MS=900000                # Time window in ms (default: 900000 = 15 minutes)
RATE_LIMIT_MAX_REQUESTS=100                # Max requests per window (default: 100)
RATE_LIMIT_ENABLED=true                    # Set to 'false' to disable (default: true)

# Optional - Query Limits
QUERY_DEFAULT_LIMIT=1000                   # Default rows returned (default: 1000)
QUERY_MAX_LIMIT=10000                      # Maximum rows allowed (default: 10000)
```

### Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `DB2I_HOSTNAME` | Yes | - | IBM i hostname or IP address |
| `DB2I_USERNAME` | Yes* | - | IBM i user profile |
| `DB2I_PASSWORD` | Yes* | - | User password |
| `DB2I_USERNAME_FILE` | No | - | Path to file containing username (overrides `DB2I_USERNAME`) |
| `DB2I_PASSWORD_FILE` | No | - | Path to file containing password (overrides `DB2I_PASSWORD`) |
| `DB2I_PORT` | No | `446` | JDBC port (446 is standard for IBM i) |
| `DB2I_DATABASE` | No | `*LOCAL` | Database name |
| `DB2I_SCHEMA` | No | - | Default schema/library for tools. If set, you don't need to specify schema in each tool call. |
| `DB2I_JDBC_OPTIONS` | No | - | Additional JDBC options (semicolon-separated) |
| `LOG_LEVEL` | No | `info` | Log level: `debug`, `info`, `warn`, `error`, `fatal` |
| `NODE_ENV` | No | - | Set to `production` for JSON logs, otherwise pretty-printed |
| `LOG_PRETTY` | No | - | Override log format: `true` = pretty, `false` = JSON |
| `LOG_COLORS` | No | auto | Override colors: `true`/`false` (auto-detects TTY by default) |
| `RATE_LIMIT_WINDOW_MS` | No | `900000` | Rate limit time window in milliseconds (15 min) |
| `RATE_LIMIT_MAX_REQUESTS` | No | `100` | Maximum requests allowed per window |
| `RATE_LIMIT_ENABLED` | No | `true` | Set to `false` or `0` to disable rate limiting |
| `QUERY_DEFAULT_LIMIT` | No | `1000` | Default number of rows returned by queries |
| `QUERY_MAX_LIMIT` | No | `10000` | Maximum rows allowed (caps user-provided limits) |

*Either the environment variable or the corresponding `*_FILE` variable must be set. File-based secrets take priority when both are provided.

### JDBC Options

Common JDBC options for IBM i (JT400/JTOpen driver):

| Option | Values | Description |
|--------|--------|-------------|
| `naming` | `system`, `sql` | `system` uses `/` for library separator, `sql` uses `.` for schema separator |
| `libraries` | `LIB1,LIB2,...` | Library list for resolving unqualified names |
| `date format` | `iso`, `usa`, `eur`, `jis`, `mdy`, `dmy`, `ymd` | Date format for date fields |
| `time format` | `iso`, `usa`, `eur`, `jis`, `hms` | Time format for time fields |
| `errors` | `full`, `basic` | Level of detail in error messages (`full` helps debugging) |
| `translate binary` | `true`, `false` | Whether to translate binary/CCSID data |
| `secure` | `true`, `false` | Enable SSL/TLS encryption |

Example: `naming=system;date format=iso;errors=full`

## Usage with Cursor

Add to your Cursor MCP settings (`~/.cursor/mcp.json`):

### Using Docker (recommended)

```json
{
  "mcpServers": {
    "db2i": {
      "command": "docker",
      "args": [
        "run", "-i", "--rm",
        "-e", "DB2I_HOSTNAME=your-host",
        "-e", "DB2I_USERNAME=your-user",
        "-e", "DB2I_PASSWORD=your-password",
        "mcp-server-db2i:latest"
      ]
    }
  }
}
```

### Using Docker with env file

```json
{
  "mcpServers": {
    "db2i": {
      "command": "docker",
      "args": [
        "run", "-i", "--rm",
        "--env-file", "/path/to/your/.env",
        "mcp-server-db2i:latest"
      ]
    }
  }
}
```

### Using docker-compose

Create a `.env` file in the project root, then:

```json
{
  "mcpServers": {
    "db2i": {
      "command": "docker-compose",
      "args": ["run", "--rm", "mcp-server-db2i"],
      "cwd": "/path/to/mcp-server-db2i"
    }
  }
}
```

The `docker-compose.yml` automatically reads from `.env` in the same directory.

### Using npx (after npm install)

```json
{
  "mcpServers": {
    "db2i": {
      "command": "npx",
      "args": ["mcp-server-db2i"],
      "env": {
        "DB2I_HOSTNAME": "your-host",
        "DB2I_USERNAME": "your-user",
        "DB2I_PASSWORD": "your-password"
      }
    }
  }
}
```

### Local development

```json
{
  "mcpServers": {
    "db2i": {
      "command": "npx",
      "args": ["tsx", "/path/to/mcp-server-db2i/src/index.ts"],
      "env": {
        "DB2I_HOSTNAME": "your-host",
        "DB2I_USERNAME": "your-user",
        "DB2I_PASSWORD": "your-password"
      }
    }
  }
}
```

## Example Queries

Once connected, you can ask the AI assistant:

- "List all schemas that contain 'PROD'"
- "Show me the tables in schema MYLIB"
- "Describe the columns in MYLIB/CUSTOMERS"
- "What indexes exist on the ORDERS table?"
- "Run this query: SELECT * FROM MYLIB.CUSTOMERS WHERE STATUS = 'A'"

## Development

```bash
# Install dependencies
npm install

# Run in development mode
npm run dev

# Build for production
npm run build

# Run production build
npm start

# Run tests
npm test

# Run tests in watch mode
npm run test:watch

# Lint code
npm run lint

# Lint and fix
npm run lint:fix

# Type check
npm run typecheck
```

## Security

- **Read-only access**: Only SELECT statements are permitted
- **No credentials in code**: All sensitive data via environment variables or file-based secrets
- **Query validation**: AST-based SQL parsing plus regex validation blocks dangerous operations
- **Result limiting**: Default limit of 1000 rows prevents large result sets
- **Rate limiting**: Configurable request throttling to prevent abuse (100 req/15 min default)
- **Structured logging**: Automatic redaction of sensitive fields like passwords

### Credential Management

The server supports multiple methods for providing credentials, listed from most to least secure:

#### Option 1: Docker Secrets (Recommended for Production)

Docker secrets provide the most secure credential management. Secrets are mounted as files and never exposed in environment variables or process listings.

1. Create secret files:

```bash
mkdir -p ./secrets
echo "your-username" > ./secrets/db2i_username.txt
echo "your-password" > ./secrets/db2i_password.txt
chmod 600 ./secrets/*.txt
```

2. Configure docker-compose.yml to use secrets:

```yaml
services:
  mcp-server-db2i:
    # ... other config ...
    environment:
      - DB2I_HOSTNAME=${DB2I_HOSTNAME}
      - DB2I_USERNAME_FILE=/run/secrets/db2i_username
      - DB2I_PASSWORD_FILE=/run/secrets/db2i_password
    secrets:
      - db2i_username
      - db2i_password

secrets:
  db2i_username:
    file: ./secrets/db2i_username.txt
  db2i_password:
    file: ./secrets/db2i_password.txt
```

For Docker Swarm or Kubernetes, use their native secret management instead of file-based secrets.

#### Option 2: External Secret Management

For enterprise deployments, integrate with secret management systems:

- **HashiCorp Vault**: Inject secrets at runtime
- **AWS Secrets Manager**: Use IAM roles for access
- **Azure Key Vault**: Integrate with managed identities

These systems can populate the `*_FILE` environment variables or inject secrets directly.

#### Option 3: Environment Variables (Development Only)

Plain environment variables are convenient for development but expose credentials through:
- `docker inspect` output
- Process listings (`ps aux`)
- Shell history
- Log files

```bash
# .env file (ensure it's in .gitignore)
DB2I_USERNAME=your-username
DB2I_PASSWORD=your-password
```

**Warning**: Never commit `.env` files or credentials to version control.

### File-Based Secret Variables

| Variable | Description |
|----------|-------------|
| `DB2I_USERNAME_FILE` | Path to file containing username (takes priority over `DB2I_USERNAME`) |
| `DB2I_PASSWORD_FILE` | Path to file containing password (takes priority over `DB2I_PASSWORD`) |

## Compatibility

- IBM i V7R3 and later (V7R5 recommended)
- Works with any IBM i system accessible via JDBC over TCP/IP

## Related Projects

- **[IBM ibmi-mcp-server](https://github.com/IBM/ibmi-mcp-server)** - IBM's official MCP server for IBM i systems. Offers YAML-based SQL tool definitions, AI agent frameworks, and production deployment options. Requires [Mapepire](https://mapepire-ibmi.github.io/) to be installed on your IBM i system, but if you can manage that prerequisite, it's worth checking out for more advanced use cases.

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## License

MIT License - see [LICENSE](LICENSE) for details.

## Acknowledgments

- [node-jt400](https://www.npmjs.com/package/node-jt400) - JT400 JDBC driver wrapper for Node.js
- [Model Context Protocol](https://modelcontextprotocol.io/) - The protocol specification
- [@modelcontextprotocol/sdk](https://github.com/modelcontextprotocol/typescript-sdk) - Official TypeScript SDK
- [IBM ibmi-mcp-server](https://github.com/IBM/ibmi-mcp-server) - SQL security validation patterns inspired by their approach to AST-based query validation