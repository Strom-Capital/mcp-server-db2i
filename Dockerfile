# MCP Server for IBM DB2i
# Multi-stage build for smaller final image

# Build stage
FROM node:20-slim AS builder

# Install build dependencies (Python, make, g++ for node-gyp, Java for node-jt400)
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    make \
    g++ \
    openjdk-17-jdk-headless \
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

# Copy source code
COPY tsconfig.json ./
COPY src ./src

# Build TypeScript
RUN npm run build

# Prune dev dependencies for smaller production image
RUN npm prune --production

# Production stage
FROM node:20-slim

# Install OpenJDK for JDBC (required by node-jt400 at runtime)
RUN apt-get update && apt-get install -y --no-install-recommends \
    openjdk-17-jre-headless \
    && rm -rf /var/lib/apt/lists/*

# Set JAVA_HOME (symlink works on both arm64 and amd64)
RUN ln -s /usr/lib/jvm/java-17-openjdk-* /usr/lib/jvm/java-17-openjdk
ENV JAVA_HOME=/usr/lib/jvm/java-17-openjdk
ENV PATH="${JAVA_HOME}/bin:${PATH}"

WORKDIR /app

# Copy package files
COPY package*.json ./

# Copy pre-built node_modules from builder (already pruned to production only)
COPY --from=builder /app/node_modules ./node_modules

# Copy built files from builder stage
COPY --from=builder /app/dist ./dist

# Create non-root user for security
RUN useradd -m -s /bin/bash mcpuser
USER mcpuser

# Environment variables (to be provided at runtime)
# Core database connection
ENV DB2I_HOSTNAME=""
ENV DB2I_PORT="446"
ENV DB2I_USERNAME=""
ENV DB2I_PASSWORD=""
ENV DB2I_DATABASE="*LOCAL"
ENV DB2I_SCHEMA=""
ENV DB2I_JDBC_OPTIONS=""

# Driver selection: 'jt400' (default, requires Java) or 'mapepire' (requires Mapepire server on IBM i)
ENV DB2I_DRIVER="jt400"

# Mapepire driver settings (only used when DB2I_DRIVER=mapepire)
ENV MAPEPIRE_PORT="8471"
ENV MAPEPIRE_IGNORE_UNAUTHORIZED="true"
ENV MAPEPIRE_POOL_MAX_SIZE="10"
ENV MAPEPIRE_POOL_STARTING_SIZE="2"
ENV MAPEPIRE_QUERY_TIMEOUT="30000"

# Logging
ENV LOG_LEVEL="info"
ENV NODE_ENV="production"

# Rate limiting
ENV RATE_LIMIT_ENABLED="true"
ENV RATE_LIMIT_WINDOW_MS="900000"
ENV RATE_LIMIT_MAX_REQUESTS="100"

# Query limits
ENV QUERY_DEFAULT_LIMIT="1000"
ENV QUERY_MAX_LIMIT="10000"

# The MCP server communicates via stdio
CMD ["node", "dist/index.js"]
