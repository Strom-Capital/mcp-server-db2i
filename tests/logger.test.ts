/**
 * Tests for the structured logging module
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

describe('Logger Module', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('Log Level Configuration', () => {
    it('should default to info level when LOG_LEVEL is not set', async () => {
      delete process.env.LOG_LEVEL;
      const { logger } = await import('../src/utils/logger.js');
      expect(logger.level).toBe('info');
    });

    it('should use LOG_LEVEL from environment when valid', async () => {
      process.env.LOG_LEVEL = 'debug';
      const { logger } = await import('../src/utils/logger.js');
      expect(logger.level).toBe('debug');
    });

    it('should handle uppercase LOG_LEVEL', async () => {
      process.env.LOG_LEVEL = 'WARN';
      const { logger } = await import('../src/utils/logger.js');
      expect(logger.level).toBe('warn');
    });

    it('should default to info for invalid LOG_LEVEL', async () => {
      process.env.LOG_LEVEL = 'invalid';
      const { logger } = await import('../src/utils/logger.js');
      expect(logger.level).toBe('info');
    });
  });

  describe('Child Logger', () => {
    it('should create child logger with additional context', async () => {
      const { createChildLogger } = await import('../src/utils/logger.js');
      const childLogger = createChildLogger({ component: 'test' });
      
      expect(childLogger).toBeDefined();
      // Child logger should have the bindings
      expect(childLogger.bindings().component).toBe('test');
    });

    it('should inherit parent log level', async () => {
      process.env.LOG_LEVEL = 'error';
      const { createChildLogger } = await import('../src/utils/logger.js');
      const childLogger = createChildLogger({ component: 'test' });
      
      expect(childLogger.level).toBe('error');
    });
  });

  describe('Sensitive Data Redaction', () => {
    it('should redact password field in log output', async () => {
      const pino = await import('pino');
      const { PassThrough } = await import('stream');
      const { REDACT_PATHS, REDACT_CENSOR } = await import('../src/utils/logger.js');
      
      // Create a stream to capture log output
      const stream = new PassThrough();
      const chunks: Buffer[] = [];
      stream.on('data', (chunk) => chunks.push(chunk));
      
      // Create a test logger using the SAME redaction config as our actual logger
      const testLogger = pino.pino({
        level: 'info',
        redact: {
          paths: [...REDACT_PATHS],
          censor: REDACT_CENSOR,
        },
      }, stream);
      
      // Log an object with password
      testLogger.info({ password: 'secret123', user: 'testuser' }, 'test message');
      
      // Wait for stream to flush
      await new Promise((resolve) => setImmediate(resolve));
      
      const output = Buffer.concat(chunks).toString();
      const parsed = JSON.parse(output);
      
      // Password should be redacted with the configured censor string
      expect(parsed.password).toBe(REDACT_CENSOR);
      // Other fields should remain
      expect(parsed.user).toBe('testuser');
    });

    it('should redact nested password fields', async () => {
      const pino = await import('pino');
      const { PassThrough } = await import('stream');
      const { REDACT_PATHS, REDACT_CENSOR } = await import('../src/utils/logger.js');
      
      const stream = new PassThrough();
      const chunks: Buffer[] = [];
      stream.on('data', (chunk) => chunks.push(chunk));
      
      // Create a test logger using the SAME redaction config as our actual logger
      const testLogger = pino.pino({
        level: 'info',
        redact: {
          paths: [...REDACT_PATHS],
          censor: REDACT_CENSOR,
        },
      }, stream);
      
      // Log nested password (simulates logging the DB config object)
      testLogger.info({ config: { password: 'secret456', host: 'localhost' } }, 'config test');
      
      await new Promise((resolve) => setImmediate(resolve));
      
      const output = Buffer.concat(chunks).toString();
      const parsed = JSON.parse(output);
      
      expect(parsed.config.password).toBe(REDACT_CENSOR);
      expect(parsed.config.host).toBe('localhost');
    });
  });

  describe('Logger Name', () => {
    it('should have the correct logger name', async () => {
      const { logger } = await import('../src/utils/logger.js');
      expect(logger.bindings().name).toBe('mcp-server-db2i');
    });
  });
});
