# syntax=docker/dockerfile:1
# check=skip=SecretsUsedInArgOrEnv

# MCP Server for IBM Db2i
# Multi-stage build with two runtime targets:
#   odbc (default): IBM i Access ODBC driver, no Java
#   jt400:          JDBC via node-jt400, ships OpenJDK 17 JRE
#
#   docker build -t mcp-server-db2i .                        # odbc image
#   docker build --target jt400 -t mcp-server-db2i:jt400 .   # jt400 image
#
# IBM publishes the ODBC driver for amd64, i386 and ppc64el only. On an arm64
# host add --platform linux/amd64, or build the jt400 target, which runs natively.
#
# Note: ENV placeholders below are intentionally empty - they're overridden at runtime
# via -e flags, --env-file, or Docker secrets. The BuildKit warning is suppressed above.

# Build stage
FROM node:22-bookworm-slim AS builder

# Install build dependencies (Python, make, g++ for node-gyp, Java for node-jt400,
# unixODBC headers in case the odbc prebuilt binary is unavailable for this platform)
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    make \
    g++ \
    openjdk-17-jdk-headless \
    unixodbc-dev \
    && rm -rf /var/lib/apt/lists/*

# Find and set JAVA_HOME (works on both arm64 and amd64)
RUN ln -s /usr/lib/jvm/java-17-openjdk-* /usr/lib/jvm/java-17-openjdk
ENV JAVA_HOME=/usr/lib/jvm/java-17-openjdk
ENV PATH="${JAVA_HOME}/bin:${PATH}"

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install all dependencies (including dev)
RUN npm ci
ENV PATH="/app/node_modules/.bin:${PATH}"

# Copy source code
COPY tsconfig.json ./
COPY src ./src

# Build TypeScript
RUN npm run build

# Prune dev dependencies for smaller production image
RUN npm prune --omit=dev

# Shared runtime layer: application files, user and env placeholders.
# The driver-specific stages below add their native runtime and set USER.
FROM node:22-bookworm-slim AS runtime-base

WORKDIR /app

# Copy package files
COPY package*.json ./

# Copy pre-built node_modules from builder (already pruned to production only)
COPY --from=builder /app/node_modules ./node_modules

# Copy built files from builder stage
COPY --from=builder /app/dist ./dist

# Create non-root user for security, and the directory export_query writes to
# (EXPORT_DIR=/data/exports). A named volume mounted there takes its owner and
# mode from this directory.
RUN useradd -m -s /bin/bash mcpuser \
    && mkdir -p /data/exports \
    && chown mcpuser:mcpuser /data/exports \
    && chmod 700 /data/exports

# Environment variables (to be provided at runtime)
# Database connection
ENV DB2I_HOSTNAME=""
ENV DB2I_USERNAME=""
ENV DB2I_PASSWORD=""
ENV DB2I_SCHEMA=""
# odbc (default) | jt400. Each runtime target sets its own value.
ENV DB2I_DRIVER=""
ENV DB2I_JDBC_OPTIONS=""
ENV DB2I_ODBC_OPTIONS=""

# Transport settings
# stdio (default) | http | both
ENV MCP_TRANSPORT="stdio"
ENV MCP_HTTP_PORT="3000"
ENV MCP_HTTP_HOST="127.0.0.1"
# stateless (default). stateful is deprecated and only keeps Mcp-Session-Id for 2025-era clients.
ENV MCP_SESSION_MODE="stateless"
ENV MCP_TOKEN_EXPIRY="3600"
ENV MCP_MAX_SESSIONS="100"

# Auth settings for HTTP transport
# required (default) | token | none
ENV MCP_AUTH_MODE="required"
ENV MCP_AUTH_TOKEN=""
ENV MCP_CORS_ORIGINS=""

# TLS settings
ENV MCP_TLS_ENABLED="false"
ENV MCP_TLS_CERT_PATH=""
ENV MCP_TLS_KEY_PATH=""

# Expose HTTP port (only used when MCP_TRANSPORT=http or both)
EXPOSE 3000

# The MCP server communicates via stdio by default
# Set MCP_TRANSPORT=http to enable HTTP API
CMD ["node", "dist/index.js"]

# JT400 runtime: OpenJDK 17 JRE for node-jt400. Builds natively on arm64.
# Bookworm is pinned because trixie has no OpenJDK 17.
FROM runtime-base AS jt400

RUN apt-get update && apt-get install -y --no-install-recommends \
    openjdk-17-jre-headless \
    && rm -rf /var/lib/apt/lists/*

# Set JAVA_HOME (symlink works on both arm64 and amd64)
RUN ln -s /usr/lib/jvm/java-17-openjdk-* /usr/lib/jvm/java-17-openjdk
ENV JAVA_HOME=/usr/lib/jvm/java-17-openjdk
ENV PATH="${JAVA_HOME}/bin:${PATH}"

ENV DB2I_DRIVER="jt400"

USER mcpuser

# ODBC runtime: unixODBC plus the IBM i Access ODBC Driver from IBM's apt
# repository (https://ibmi-oss-docs.readthedocs.io/en/latest/odbc/installation.html).
# Default target, kept last so `docker build .` builds it. No Java.
# IBM publishes the driver for amd64, i386 and ppc64el only, so on an arm64
# host build with: docker build --platform linux/amd64 .
FROM runtime-base AS odbc

ARG TARGETARCH
RUN case "$TARGETARCH" in \
      amd64|ppc64le|386) ;; \
      *) echo "The IBM i Access ODBC Driver is not published for $TARGETARCH. Build with --platform linux/amd64." >&2; exit 1 ;; \
    esac

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    unixodbc \
    && curl -fsSL https://public.dhe.ibm.com/software/ibmi/products/odbc/debs/dists/1.1.0/ibmi-acs-1.1.0.list \
       -o /etc/apt/sources.list.d/ibmi-acs-1.1.0.list \
    && apt-get update && apt-get install -y --no-install-recommends ibm-iaccess \
    && apt-get purge -y curl && apt-get autoremove -y \
    && rm -rf /var/lib/apt/lists/*

ENV DB2I_DRIVER="odbc"

USER mcpuser
