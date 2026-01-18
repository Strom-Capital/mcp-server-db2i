# Cursor Integration

This guide covers setting up mcp-server-db2i with Cursor and other MCP-compatible clients.

## Configuration File

Add mcp-server-db2i to your Cursor MCP settings file:

- **macOS/Linux**: `~/.cursor/mcp.json`
- **Windows**: `%USERPROFILE%\.cursor\mcp.json`

## Setup Options

### Using Docker (Recommended)

The simplest and most portable option. Requires Docker to be installed.

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

Store credentials in a separate file for better security:

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

If you have Node.js installed globally:

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

## Claude Desktop

The same configuration format works for Claude Desktop. Add to:

- **macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows**: `%APPDATA%\Claude\claude_desktop_config.json`

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
