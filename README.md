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
| `list_indexes` | List indexes for a table |
| `get_table_constraints` | Get primary keys, foreign keys, unique constraints |

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

# Optional
DB2I_PORT=446                              # Default: 446
DB2I_DATABASE=*LOCAL                       # Default: *LOCAL
DB2I_SCHEMA=your-default-schema            # Default schema for all tools (can be overridden per-call)
DB2I_JDBC_OPTIONS=naming=system;date format=iso
```

### Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `DB2I_HOSTNAME` | Yes | - | IBM i hostname or IP address |
| `DB2I_USERNAME` | Yes | - | IBM i user profile |
| `DB2I_PASSWORD` | Yes | - | User password |
| `DB2I_PORT` | No | `446` | JDBC port (446 is standard for IBM i) |
| `DB2I_DATABASE` | No | `*LOCAL` | Database name |
| `DB2I_SCHEMA` | No | - | Default schema/library for tools. If set, you don't need to specify schema in each tool call. |
| `DB2I_JDBC_OPTIONS` | No | - | Additional JDBC options (semicolon-separated) |

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
```

## Security

- **Read-only access**: Only SELECT statements are permitted
- **No credentials in code**: All sensitive data via environment variables
- **Query validation**: Dangerous SQL keywords are blocked
- **Result limiting**: Default limit of 1000 rows prevents large result sets

## Compatibility

- IBM i V7R3 and later (V7R5 recommended)
- Works with any IBM i system accessible via JDBC over TCP/IP

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## License

MIT License - see [LICENSE](LICENSE) for details.

## Acknowledgments

- [node-jt400](https://www.npmjs.com/package/node-jt400) - JT400 JDBC driver wrapper for Node.js
- [Model Context Protocol](https://modelcontextprotocol.io/) - The protocol specification
- [@modelcontextprotocol/sdk](https://github.com/modelcontextprotocol/typescript-sdk) - Official TypeScript SDK
