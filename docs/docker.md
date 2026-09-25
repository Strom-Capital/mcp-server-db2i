# Docker Guide

This guide covers running mcp-server-db2i with Docker and docker-compose.

## Quick Start

### Build the Image

```bash
docker build -t mcp-server-db2i .
```

This builds the default `odbc` image with the IBM i Access ODBC Driver. IBM publishes that driver for amd64 only, so on an arm64 host such as an Apple Silicon Mac add `--platform linux/amd64`, or build the `jt400` image instead. See [Multi-Stage Build](#multi-stage-build).

### Run with Environment Variables

> **Security Warning:** Passing credentials via `-e` flags exposes them in process lists (`ps aux`), `docker inspect` output, and shell history. Use `--env-file` for local testing and Docker secrets for production deployments.

```bash
# For quick local testing only - not recommended for production
docker run -i --rm \
  -e DB2I_HOSTNAME=your-host \
  -e DB2I_USERNAME=your-user \
  -e DB2I_PASSWORD=your-password \
  mcp-server-db2i
```

### Run with env file (Recommended)

```bash
docker run -i --rm \
  --env-file .env \
  mcp-server-db2i
```

## Docker Compose

### Basic Setup

Create a `.env` file:

```env
DB2I_HOSTNAME=your-ibmi-host.com
DB2I_USERNAME=your-username
DB2I_PASSWORD=your-password
```

Run with docker-compose:

```bash
docker-compose run --rm mcp-server-db2i
```

### HTTP Transport

To expose the HTTP API, uncomment the `ports` section in `docker-compose.yml`:

```yaml
services:
  mcp-server-db2i:
    # ...
    ports:
      - "${MCP_HTTP_PORT:-3000}:${MCP_HTTP_PORT:-3000}"
    environment:
      - MCP_TRANSPORT=http
      # ...
```

Then run:

```bash
docker-compose up -d
```

## Docker Secrets

For production deployments, use Docker secrets instead of environment variables.

### 1. Create Secret Files

```bash
mkdir -p ./secrets

# Securely prompt for username (doesn't leak to shell history)
read -p "Enter DB2i username: " username
echo "$username" > ./secrets/db2i_username.txt

# Securely prompt for password (hidden input)
read -s -p "Enter DB2i password: " password
echo
echo "$password" > ./secrets/db2i_password.txt

chmod 600 ./secrets/*.txt
```

> **Security Note:** Avoid using `echo "password" > file` directly, as it may be logged in shell history. The `read -s` command hides input from the terminal.

### 2. Update docker-compose.yml

```yaml
services:
  mcp-server-db2i:
    build: .
    container_name: mcp-server-db2i
    stdin_open: true
    tty: true
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

### 3. Run

```bash
docker-compose up -d
```

## TLS with Docker

### Using Built-in TLS

1. Mount your certificates:

```yaml
services:
  mcp-server-db2i:
    # ...
    volumes:
      - ./certs:/certs:ro
    environment:
      - MCP_TLS_ENABLED=true
      - MCP_TLS_CERT_PATH=/certs/server.crt
      - MCP_TLS_KEY_PATH=/certs/server.key
```

2. Generate self-signed certificates (for testing):

```bash
mkdir -p ./certs
openssl req -x509 -newkey rsa:4096 -keyout certs/server.key -out certs/server.crt -days 365 -nodes -subj "/CN=localhost"
```

### Using Reverse Proxy

For production, use a reverse proxy like nginx or Traefik for TLS termination:

```yaml
services:
  mcp-server-db2i:
    # ...
    environment:
      # 0.0.0.0 so the proxy container can reach this process. 127.0.0.1 is only this container's loopback.
      - MCP_HTTP_HOST=0.0.0.0
      - MCP_HTTP_PORT=3000
      # Name clients send in Host. Loopback alone is not enough once a proxy forwards a public hostname.
      - MCP_ALLOWED_HOSTS=db2i.example.com

  nginx:
    image: nginx:alpine
    ports:
      - "443:443"
    volumes:
      - ./nginx.conf:/etc/nginx/nginx.conf:ro
      - ./certs:/etc/nginx/certs:ro
    depends_on:
      - mcp-server-db2i
```

## Environment Variables

All environment variables can be set in docker-compose.yml or via `.env` file:

```yaml
environment:
  # Database connection
  - DB2I_HOSTNAME=${DB2I_HOSTNAME}
  - DB2I_USERNAME=${DB2I_USERNAME}
  - DB2I_PASSWORD=${DB2I_PASSWORD}
  - DB2I_SCHEMA=${DB2I_SCHEMA:-}
  # DB2I_DRIVER is set by the image target (odbc or jt400)
  - DB2I_JDBC_OPTIONS=${DB2I_JDBC_OPTIONS:-}
  - DB2I_ODBC_OPTIONS=${DB2I_ODBC_OPTIONS:-}
  
  # Transport settings
  - MCP_TRANSPORT=${MCP_TRANSPORT:-stdio}
  - MCP_HTTP_PORT=${MCP_HTTP_PORT:-3000}
  - MCP_HTTP_HOST=${MCP_HTTP_HOST:-127.0.0.1}
  - MCP_ALLOWED_HOSTS=${MCP_ALLOWED_HOSTS:-}
  - MCP_SESSION_MODE=${MCP_SESSION_MODE:-stateless}
  - MCP_TOKEN_EXPIRY=${MCP_TOKEN_EXPIRY:-3600}
  - MCP_MAX_SESSIONS=${MCP_MAX_SESSIONS:-100}
  
  # TLS settings
  - MCP_TLS_ENABLED=${MCP_TLS_ENABLED:-false}
  - MCP_TLS_CERT_PATH=${MCP_TLS_CERT_PATH:-}
  - MCP_TLS_KEY_PATH=${MCP_TLS_KEY_PATH:-}
  
  # Rate limiting
  - RATE_LIMIT_WINDOW_MS=${RATE_LIMIT_WINDOW_MS:-900000}
  - RATE_LIMIT_MAX_REQUESTS=${RATE_LIMIT_MAX_REQUESTS:-100}
  - RATE_LIMIT_ENABLED=${RATE_LIMIT_ENABLED:-true}
  - AUTH_RATE_LIMIT_MAX_ATTEMPTS=${AUTH_RATE_LIMIT_MAX_ATTEMPTS:-5}
  - AUTH_RATE_LIMIT_WINDOW_MS=${AUTH_RATE_LIMIT_WINDOW_MS:-60000}
  - OAUTH_RATE_LIMIT_MAX_REQUESTS=${OAUTH_RATE_LIMIT_MAX_REQUESTS:-120}
  - OAUTH_RATE_LIMIT_WINDOW_MS=${OAUTH_RATE_LIMIT_WINDOW_MS:-60000}
  
  # Query limits
  - QUERY_DEFAULT_LIMIT=${QUERY_DEFAULT_LIMIT:-1000}
  - QUERY_MAX_LIMIT=${QUERY_MAX_LIMIT:-10000}
  - QUERY_TIMEOUT=${QUERY_TIMEOUT:-}
  - QUERY_ALLOWED_SCHEMAS=${QUERY_ALLOWED_SCHEMAS:-}
  - QUERY_PARSE_CHECK=${QUERY_PARSE_CHECK:-}
  
  # Tool selection and response format
  - MCP_TOOLS_ENABLED=${MCP_TOOLS_ENABLED:-}
  - MCP_TOOLS_DISABLED=${MCP_TOOLS_DISABLED:-}
  - MCP_CUSTOM_TOOLS=${MCP_CUSTOM_TOOLS:-}
  - MCP_RESPONSE_FORMAT=${MCP_RESPONSE_FORMAT:-json}
  
  # Logging
  - LOG_LEVEL=${LOG_LEVEL:-info}
```

## Business SQL tools

Mount a directory of YAML tool files and point `MCP_CUSTOM_TOOLS` at it. The example pack in `examples/erp-tools` uses placeholder names such as `MYLIB.ORDERHDR`. Edit those names before relying on the tools.

```yaml
services:
  mcp-server-db2i:
    environment:
      - MCP_CUSTOM_TOOLS=/tools
      - QUERY_ALLOWED_SCHEMAS=MYLIB
    volumes:
      - ./examples/erp-tools:/tools:ro
```

The server reads the files at startup. A statement that is not a query, or that names a library outside `QUERY_ALLOWED_SCHEMAS`, stops the container. See [Business SQL tools](custom-tools.md).

## Multi-Stage Build

The Dockerfile uses a multi-stage build with two runtime targets:

1. **Builder stage**: Compiles TypeScript to JavaScript and prunes dev dependencies
2. **`odbc` target** (default): unixODBC and the IBM i Access ODBC Driver from IBM's apt repository, no Java. Sets `DB2I_DRIVER=odbc`.
3. **`jt400` target**: OpenJDK 17 JRE for the JT400 JDBC driver. Sets `DB2I_DRIVER=jt400`.

```bash
# ODBC image (default), no JDK or JRE
docker build -t mcp-server-db2i .
docker run --rm -i --env-file .env -e DB2I_ODBC_OPTIONS="SSL=1" mcp-server-db2i

# JDBC image
docker build --target jt400 -t mcp-server-db2i:jt400 .
```

IBM publishes the ODBC driver package for amd64, i386 and ppc64el only. On an arm64 host such as an Apple Silicon Mac, build and run the ODBC image under emulation with `--platform linux/amd64`; the build fails early with a message otherwise. The `jt400` image builds natively on arm64.

```bash
docker build --platform linux/amd64 -t mcp-server-db2i .
```

Either image can run the `mapepire` driver, because it needs nothing native. Override the driver and pin the host key, since the container has no `known_hosts`. Alternatively, mount a known_hosts file and set `knownHostsFile` to its path.

```bash
docker run --rm -i --env-file .env -e DB2I_DRIVER=mapepire \
  -e DB2I_MAPEPIRE_OPTIONS="hostKey=SHA256:abc...xyz" mcp-server-db2i:jt400
```

The bundled `docker-compose.yml` builds the ODBC image with `platform: linux/amd64`. To use the JDBC image, set `target: jt400` under `build` and remove the `platform` line.

Both images:
- Use `node:22-bookworm-slim`. Bookworm is pinned so OpenJDK 17 stays available for the `jt400` target. Debian trixie does not package it.
- Run as non-root user (`mcpuser`)
- Include only production dependencies
- Default `MCP_SESSION_MODE` to `stateless`, matching the server. `stateful` is deprecated.

The `odbc` image installs `ibm-iaccess` from `public.dhe.ibm.com` at build time, so the build needs network access to that host. See [Database Drivers](configuration.md#database-drivers) for the ODBC keywords.

## Health Checks

For HTTP transport, add a health check:

```yaml
services:
  mcp-server-db2i:
    # ...
    healthcheck:
      test: ["CMD", "node", "-e", "fetch('http://127.0.0.1:3000/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"]
      interval: 30s
      timeout: 10s
      retries: 3
      start_period: 10s
```

> **Note:** The image is Debian slim and does not include `curl` or `wget`. The check uses Node's built-in `fetch`.

## Resource Limits

Set resource limits for production:

```yaml
services:
  mcp-server-db2i:
    # ...
    deploy:
      resources:
        limits:
          cpus: '1'
          memory: 512M
        reservations:
          cpus: '0.25'
          memory: 256M
```

## Logging

### View Logs

```bash
# Follow logs
docker-compose logs -f mcp-server-db2i

# Last 100 lines
docker-compose logs --tail=100 mcp-server-db2i
```

### Log Configuration

For production, use JSON logging:

```yaml
environment:
  - NODE_ENV=production
  - LOG_LEVEL=info
```

### Log Drivers

Configure Docker log drivers for centralized logging:

```yaml
services:
  mcp-server-db2i:
    # ...
    logging:
      driver: "json-file"
      options:
        max-size: "10m"
        max-file: "3"
```

## Networking

### Bridge Network (default)

```yaml
services:
  mcp-server-db2i:
    # ...
    networks:
      - app-network

networks:
  app-network:
    driver: bridge
```

### Host Network

For better performance (Linux only):

```yaml
services:
  mcp-server-db2i:
    # ...
    network_mode: host
```

## Example: Complete Production Setup

```yaml
version: '3.8'

services:
  mcp-server-db2i:
    build: .
    container_name: mcp-server-db2i
    restart: unless-stopped
    ports:
      - "3000:3000"
    environment:
      - DB2I_HOSTNAME=${DB2I_HOSTNAME}
      - DB2I_USERNAME_FILE=/run/secrets/db2i_username
      - DB2I_PASSWORD_FILE=/run/secrets/db2i_password
      - DB2I_SCHEMA=${DB2I_SCHEMA}
      - MCP_TRANSPORT=http
      - MCP_HTTP_HOST=0.0.0.0
      - MCP_ALLOWED_HOSTS=${MCP_ALLOWED_HOSTS:-}
      - MCP_TLS_ENABLED=true
      - MCP_TLS_CERT_PATH=/certs/server.crt
      - MCP_TLS_KEY_PATH=/certs/server.key
      - NODE_ENV=production
      - LOG_LEVEL=info
    secrets:
      - db2i_username
      - db2i_password
    volumes:
      - ./certs:/certs:ro
    healthcheck:
      test: ["CMD", "node", "-e", "process.env.NODE_TLS_REJECT_UNAUTHORIZED='0'; fetch('https://127.0.0.1:3000/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"]
      interval: 30s
      timeout: 10s
      retries: 3
    deploy:
      resources:
        limits:
          cpus: '1'
          memory: 512M
    logging:
      driver: "json-file"
      options:
        max-size: "10m"
        max-file: "3"

secrets:
  db2i_username:
    file: ./secrets/db2i_username.txt
  db2i_password:
    file: ./secrets/db2i_password.txt
```

## Troubleshooting

### Container Won't Start

1. Check logs: `docker-compose logs mcp-server-db2i`
2. Verify environment variables are set
3. Ensure IBM i is reachable from container

### Connection Refused

1. Check if IBM i port (446) is accessible
2. Verify hostname resolves correctly
3. Check firewall rules

### Permission Denied

1. Ensure secret files have correct permissions
2. Check volume mount permissions
3. Verify non-root user has access

### Out of Memory

1. Increase memory limits
2. Reduce `QUERY_MAX_LIMIT`
3. Lower `MCP_MAX_SESSIONS`
