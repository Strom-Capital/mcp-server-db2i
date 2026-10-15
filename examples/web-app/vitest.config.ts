import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./', import.meta.url)),
      'server-only': fileURLToPath(new URL('./tests/server-only.ts', import.meta.url)),
    },
  },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    env: {
      MCP_SERVER_URL: 'http://mcp.example.com',
      APP_URL: 'http://localhost:3001',
      SESSION_SECRET: 'test-secret-that-is-at-least-32-characters-long',
    },
  },
});
