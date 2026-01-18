# Docker Guide

This guide covers running mcp-server-db2i with Docker and docker-compose.

## Quick Start

### Build the Image

```bash
docker build -t mcp-server-db2i .
```

### Run with Environment Variables

```bash
docker run -i --rm \
  -e DB2I_HOSTNAME=your-host \
  -e DB2I_USERNAME=your-user \
  -e DB2I_PASSWORD=your-password \
  mcp-server-db2i
```

### Run with env file

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
echo "your-username" > ./secrets/db2i_username.txt
echo "your-password" > ./secrets/db2i_password.txt
chmod 600 ./secrets/*.txt
```

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
      - MCP_HTTP_HOST=127.0.0.1  # Only bind to localhost
      - MCP_HTTP_PORT=3000

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
  - DB2I_PORT=${DB2I_PORT:-446}
  - DB2I_DATABASE=${DB2I_DATABASE:-*LOCAL}
  - DB2I_USERNAME=${DB2I_USERNAME}
  - DB2I_PASSWORD=${DB2I_PASSWORD}
  - DB2I_SCHEMA=${DB2I_SCHEMA:-}
  - DB2I_JDBC_OPTIONS=${DB2I_JDBC_OPTIONS:-}
  
  # Transport settings
  - MCP_TRANSPORT=${MCP_TRANSPORT:-stdio}
  - MCP_HTTP_PORT=${MCP_HTTP_PORT:-3000}
  - MCP_HTTP_HOST=${MCP_HTTP_HOST:-0.0.0.0}
  - MCP_SESSION_MODE=${MCP_SESSION_MODE:-stateful}
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
  
  # Query limits
  - QUERY_DEFAULT_LIMIT=${QUERY_DEFAULT_LIMIT:-1000}
  - QUERY_MAX_LIMIT=${QUERY_MAX_LIMIT:-10000}
  
  # Logging
  - LOG_LEVEL=${LOG_LEVEL:-info}
```

## Multi-Stage Build

The Dockerfile uses a multi-stage build for minimal image size:

1. **Builder stage**: Compiles TypeScript to JavaScript
2. **Production stage**: Contains only runtime dependencies

The final image:
- Uses Node.js Alpine for small size
- Runs as non-root user (`mcpuser`)
- Includes only production dependencies

## Health Checks

For HTTP transport, add a health check:

```yaml
services:
  mcp-server-db2i:
    # ...
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:3000/health"]
      interval: 30s
      timeout: 10s
      retries: 3
      start_period: 10s
```

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
      test: ["CMD", "curl", "-f", "https://localhost:3000/health", "--insecure"]
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
