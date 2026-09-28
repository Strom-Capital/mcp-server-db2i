---
title: "Client setup"
description: "Configure Cursor, VS Code, Claude Desktop, and Claude Code to start mcp-server-db2i, with npx or Docker."
---

This guide covers setting up mcp-server-db2i with MCP-compatible clients. Cursor, Claude Desktop and Claude Code use the same JSON format, and only the file location differs. VS Code uses its own format; see [VS Code](#vs-code-agent-mode).

## Configuration Paths

### Cursor

- **macOS/Linux**: `~/.cursor/mcp.json`
- **Windows**: `%USERPROFILE%\.cursor\mcp.json`
- **Env var syntax**: `${env:VAR_NAME}`

### VS Code

- **Workspace**: `.vscode/mcp.json` in the project folder
- **User**: run **MCP: Open User Configuration** from the Command Palette
- **Format**: a `servers` object instead of `mcpServers`, and an optional `inputs` list
- **Secrets**: `${input:ID}` prompts once and stores the value in VS Code's secret storage

### Claude Desktop

- **macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Linux**: `~/.config/Claude/claude_desktop_config.json`
- **Windows**: `%APPDATA%\Claude\claude_desktop_config.json`

### Claude Code

- **All platforms**: `~/.claude.json`
- **Project-specific**: `.mcp.json` in project root
- **Env var syntax**: `${VAR_NAME}`
- **CLI**: `claude mcp add --scope user db2i -- npx -y mcp-server-db2i@latest`

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
      "args": ["-y", "mcp-server-db2i@latest"],
      "env": {
        "DB2I_HOSTNAME": "${env:DB2I_HOSTNAME}",
        "DB2I_USERNAME": "${env:DB2I_USERNAME}",
        "DB2I_PASSWORD": "${env:DB2I_PASSWORD}"
      }
    }
  }
}
```

#### Choosing a version

`mcp-server-db2i@latest` makes npx ask npm for the newest release each time the client starts the server, so you get fixes without doing anything. Without a version, npx keeps running whichever version it cached first and never updates it.

To upgrade on your own schedule, for example on a shared or production setup, pin an exact version instead: `"args": ["-y", "mcp-server-db2i@3.0.0"]`. Major versions can change setup steps, so read the [changelog](https://github.com/Strom-Capital/mcp-server-db2i/blob/main/CHANGELOG.md) before moving to a new one.

#### Drivers that need extra packages

The `jt400` and `mapepire` drivers need packages that npx does not install by default. Pass them with `-p`:

```json
"args": ["-y", "-p", "mcp-server-db2i@latest", "-p", "node-jt400", "mcp-server-db2i"]
```

For `mapepire`, use `"-p", "@ibm/mapepire-js", "-p", "ssh2"` instead of `"-p", "node-jt400"`. Set `DB2I_DRIVER` in `env` as well. See [Installing the jt400 and mapepire packages](configuration.md#installing-the-jt400-and-mapepire-packages).

### Using npx with inline credentials

> **Security Warning:** This stores credentials in plain text in your config file. Only use for local development or testing.

```json
{
  "mcpServers": {
    "db2i": {
      "command": "npx",
      "args": ["-y", "mcp-server-db2i@latest"],
      "env": {
        "DB2I_HOSTNAME": "your-host",
        "DB2I_USERNAME": "your-user",
        "DB2I_PASSWORD": "your-password"
      }
    }
  }
}
```

### VS Code (agent mode)

VS Code starts MCP servers for agent mode in Copilot Chat. Add `.vscode/mcp.json` to your project. The `inputs` entry makes VS Code ask for the password the first time the server starts, so it is not stored in the file:

```json
{
  "inputs": [
    { "type": "promptString", "id": "db2i-password", "description": "IBM i password", "password": true }
  ],
  "servers": {
    "db2i": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "mcp-server-db2i@latest"],
      "env": {
        "DB2I_HOSTNAME": "ibmi.example.com",
        "DB2I_USERNAME": "MYUSER",
        "DB2I_PASSWORD": "${input:db2i-password}",
        "DB2I_SCHEMA": "MYLIB",
        "QUERY_ALLOWED_SCHEMAS": "MYLIB,QSYS2"
      }
    }
  }
}
```

Start the server from the **Start** link above `db2i` in the file, or with **MCP: List Servers**. **MCP: List Servers > db2i > Show Output** shows the server log. When it connects, VS Code lists the tools under **Configure Tools** in the Chat view.

- `export_query` only appears when `EXPORT_ENABLED` is set, so VS Code lists one tool fewer than the startup log by default.
- If the host servers use SSL, add `"DB2I_ODBC_OPTIONS": "SSL=1"` to `env`. Without it the log warns that the connection does not use TLS.
- For the `jt400` or `mapepire` driver, change `args` as shown in [Drivers that need extra packages](#drivers-that-need-extra-packages) and set `DB2I_DRIVER`. If Code for IBM i has already deployed the Mapepire server JAR to `$HOME/.vscode` on the IBM i, the `mapepire` driver reuses it instead of uploading its own to `$HOME/.mapepire`.
- Keep `.vscode/mcp.json` out of version control if it names a real host or user profile.

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

### With Custom Driver Options

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
        "-e", "DB2I_ODBC_OPTIONS=SSL=1",
        "mcp-server-db2i:latest"
      ]
    }
  }
}
```

`DB2I_ODBC_OPTIONS` applies to the default `odbc` image. With the `jt400` image, pass JDBC properties in `DB2I_JDBC_OPTIONS` instead, for example `naming=sql;date format=iso;errors=full`. See [Configuration](configuration.md#database-drivers).

### With Debug Logging

Enable debug logging for troubleshooting:

```json
{
  "mcpServers": {
    "db2i": {
      "command": "npx",
      "args": ["-y", "mcp-server-db2i@latest"],
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

## Claude for Excel

Claude for Excel, the Claude add-in for Microsoft Excel, can use this server through a claude.ai connector. People ask in the Claude sidebar in Excel, and Claude queries Db2 for i and puts the results in the sheet.

It needs the same setup as claude.ai:

1. Run the server over HTTP with OAuth at a public HTTPS address. See [Remote clients (OAuth)](http-transport.md#remote-clients-oauth).
2. Limit who can reach it to the clients' address ranges. See [Limiting who can reach the server](http-transport.md#limiting-who-can-reach-the-server).
3. Add the server as a custom connector in claude.ai: **Settings > Connectors > Add custom connector**. On Team and Enterprise plans, an owner may need to add it for the organization.
4. In Excel, open Claude with the same Claude account. The connector is available from the sidebar.

Claude for Excel needs a paid Claude plan. As with any assistant, query results go to Claude; see [Where data goes](security.md#where-data-goes).

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
      "args": ["-y", "mcp-server-db2i@latest"],
      "env": {
        "DB2I_HOSTNAME": "prod-ibmi.example.com",
        "DB2I_USERNAME": "produser",
        "DB2I_PASSWORD": "prodpass",
        "DB2I_SCHEMA": "PRODLIB"
      }
    },
    "db2i-dev": {
      "command": "npx",
      "args": ["-y", "mcp-server-db2i@latest"],
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
      "args": ["-y", "mcp-server-db2i@latest"],
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
claude mcp add --scope user db2i -- npx -y mcp-server-db2i@latest

# With the jt400 driver, add its package to the npx command
claude mcp add --scope user db2i -e DB2I_DRIVER=jt400 -- npx -y -p mcp-server-db2i@latest -p node-jt400 mcp-server-db2i

# Verify installation
claude mcp list
```
