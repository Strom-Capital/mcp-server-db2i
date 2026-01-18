# Client Setup

This guide covers setting up mcp-server-db2i with MCP-compatible clients. The JSON configuration format is the same for all clients - only the file location differs.

## Configuration Paths

### Cursor

- **macOS/Linux**: `~/.cursor/mcp.json`
- **Windows**: `%USERPROFILE%\.cursor\mcp.json`
- **Env var syntax**: `${env:VAR_NAME}`

### Claude Desktop

- **macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Linux**: `~/.config/Claude/claude_desktop_config.json`
- **Windows**: `%APPDATA%\Claude\claude_desktop_config.json`

### Claude Code

- **All platforms**: `~/.claude.json`
- **Project-specific**: `.mcp.json` in project root
- **Env var syntax**: `${VAR_NAME}`
- **CLI**: `claude mcp add --scope user db2i -- npx mcp-server-db2i`

## Setup Options

### Using Docker with env file (Recommended)

Store credentials in a separate `.env` file for security. For production deployments, see [Docker Secrets](docker.md#docker-secrets) for the most secure approach.

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

Create a `.env` file with your credentials:

```env
DB2I_HOSTNAME=your-ibmi-host.com
DB2I_USERNAME=your-username
DB2I_PASSWORD=your-password
```

### Using Docker with inline credentials

> **Security Warning:** This stores credentials in plain text in your config file. Only use for local development or testing.

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

### Using npx (Recommended for Cursor)

Use environment variable expansion to keep credentials out of config files.

1. Set credentials in your shell profile (`~/.zshrc` or `~/.bashrc`):

```bash
export DB2I_HOSTNAME="your-host"
export DB2I_USERNAME="your-user"
export DB2I_PASSWORD="your-password"
```

2. Use `${env:VAR}` syntax in your Cursor config:

```json
{
  "mcpServers": {
    "db2i": {
      "command": "npx",
      "args": ["mcp-server-db2i"],
      "env": {
        "DB2I_HOSTNAME": "${env:DB2I_HOSTNAME}",
        "DB2I_USERNAME": "${env:DB2I_USERNAME}",
        "DB2I_PASSWORD": "${env:DB2I_PASSWORD}"
      }
    }
  }
}
```

### Using npx with inline credentials

> **Security Warning:** This stores credentials in plain text in your config file. Only use for local development or testing.

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

### Local Development

For development or customization:

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

## Configuration Options

### With Default Schema

Set a default schema to avoid specifying it in every query:

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
        "-e", "DB2I_SCHEMA=MYLIB",
        "mcp-server-db2i:latest"
      ]
    }
  }
}
```

### With Custom JDBC Options

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
        "-e", "DB2I_JDBC_OPTIONS=naming=sql;date format=iso;errors=full",
        "mcp-server-db2i:latest"
      ]
    }
  }
}
```

### With Debug Logging

Enable debug logging for troubleshooting:

```json
{
  "mcpServers": {
    "db2i": {
      "command": "npx",
      "args": ["mcp-server-db2i"],
      "env": {
        "DB2I_HOSTNAME": "your-host",
        "DB2I_USERNAME": "your-user",
        "DB2I_PASSWORD": "your-password",
        "LOG_LEVEL": "debug"
      }
    }
  }
}
```

## Example Prompts

Once connected, you can ask the AI assistant:

### Schema Exploration

- "List all schemas that contain 'PROD'"
- "Show me all schemas on this system"
- "What libraries are available?"

### Table Discovery

- "Show me the tables in schema MYLIB"
- "List all tables that start with 'CUST'"
- "What tables are in the QGPL library?"

### Column Information

- "Describe the columns in MYLIB/CUSTOMERS"
- "What's the structure of the ORDERS table?"
- "Show me the data types for MYLIB.INVENTORY"

### Indexes and Constraints

- "What indexes exist on the ORDERS table?"
- "Show me the primary key for CUSTOMERS"
- "List all foreign keys in the SALES schema"

### SQL Queries

- "Run this query: SELECT * FROM MYLIB.CUSTOMERS WHERE STATUS = 'A'"
- "Count the records in ORDERS where YEAR = 2024"
- "Find customers with no orders in the last year"

## Troubleshooting

### Connection Issues

1. **Check hostname resolution**: Ensure the IBM i hostname is reachable
2. **Verify credentials**: Test with a known-good username/password
3. **Check port**: Default is 446, verify firewall allows access
4. **Enable debug logging**: Set `LOG_LEVEL=debug`

### Docker Issues

1. **Image not found**: Build the image first with `docker build -t mcp-server-db2i .`
2. **Permission denied**: Ensure Docker daemon is running
3. **Network issues**: Check Docker network settings if IBM i is not reachable

### Tool Errors

1. **Schema not found**: Verify schema name is correct (case-sensitive on IBM i)
2. **Table not found**: Ensure table exists and user has SELECT permission
3. **Rate limit exceeded**: Wait for the window to reset or adjust limits

### Viewing Logs

For stdio transport, logs go to stderr. Docker logs can be viewed with:

```bash
# If running detached
docker logs <container-id>

# Real-time logs
docker logs -f <container-id>
```

## Multiple Connections

You can configure multiple IBM i connections:

```json
{
  "mcpServers": {
    "db2i-prod": {
      "command": "npx",
      "args": ["mcp-server-db2i"],
      "env": {
        "DB2I_HOSTNAME": "prod-ibmi.example.com",
        "DB2I_USERNAME": "produser",
        "DB2I_PASSWORD": "prodpass",
        "DB2I_SCHEMA": "PRODLIB"
      }
    },
    "db2i-dev": {
      "command": "npx",
      "args": ["mcp-server-db2i"],
      "env": {
        "DB2I_HOSTNAME": "dev-ibmi.example.com",
        "DB2I_USERNAME": "devuser",
        "DB2I_PASSWORD": "devpass",
        "DB2I_SCHEMA": "DEVLIB"
      }
    }
  }
}
```

Then specify which connection to use in your prompts: "Using db2i-prod, list all tables in PRODLIB"

## Claude Code CLI

Claude Code supports environment variable expansion using `${VAR}` syntax, which is the recommended secure approach.

### Secure setup with environment variables

1. Set credentials in your shell profile (`~/.zshrc` or `~/.bashrc`):

```bash
export DB2I_HOSTNAME="your-host"
export DB2I_USERNAME="your-user"
export DB2I_PASSWORD="your-password"
```

2. Add to `~/.claude.json` with variable references:

```json
{
  "mcpServers": {
    "db2i": {
      "command": "npx",
      "args": ["mcp-server-db2i"],
      "env": {
        "DB2I_HOSTNAME": "${DB2I_HOSTNAME}",
        "DB2I_USERNAME": "${DB2I_USERNAME}",
        "DB2I_PASSWORD": "${DB2I_PASSWORD}"
      }
    }
  }
}
```

This keeps credentials out of config files - Claude Code expands `${VAR}` at runtime.

### Using the CLI

```bash
# Add server (credentials from shell environment)
claude mcp add --scope user db2i -- npx mcp-server-db2i

# Verify installation
claude mcp list
```
