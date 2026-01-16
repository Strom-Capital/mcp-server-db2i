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
ENV DB2I_HOSTNAME=""
ENV DB2I_PORT="446"
ENV DB2I_USERNAME=""
ENV DB2I_PASSWORD=""
ENV DB2I_DATABASE="*LOCAL"
ENV DB2I_SCHEMA=""
ENV DB2I_JDBC_OPTIONS=""

# The MCP server communicates via stdio
CMD ["node", "dist/index.js"]
