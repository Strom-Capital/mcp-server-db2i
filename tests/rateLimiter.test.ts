/**
 * Tests for the rate limiter module
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  RateLimiter,
  loadRateLimitConfig,
  resetRateLimiterInstance,
  getRateLimiter,
} from '../src/utils/rateLimiter.js';
import { DEFAULT_RATE_LIMIT } from '../src/config.js';

describe('Rate Limiter', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
    resetRateLimiterInstance();
  });

  afterEach(() => {
    process.env = originalEnv;
    resetRateLimiterInstance();
  });

  describe('loadRateLimitConfig', () => {
    it('should use default values when env vars not set', () => {
      delete process.env.RATE_LIMIT_WINDOW_MS;
      delete process.env.RATE_LIMIT_MAX_REQUESTS;
      delete process.env.RATE_LIMIT_ENABLED;

      const config = loadRateLimitConfig();

      expect(config.windowMs).toBe(DEFAULT_RATE_LIMIT.windowMs);
      expect(config.maxRequests).toBe(DEFAULT_RATE_LIMIT.maxRequests);
      expect(config.enabled).toBe(true);
    });

    it('should use env vars when set', () => {
      process.env.RATE_LIMIT_WINDOW_MS = '60000';
      process.env.RATE_LIMIT_MAX_REQUESTS = '50';

      const config = loadRateLimitConfig();

      expect(config.windowMs).toBe(60000);
      expect(config.maxRequests).toBe(50);
    });

    it('should disable rate limiting when RATE_LIMIT_ENABLED is false', () => {
      process.env.RATE_LIMIT_ENABLED = 'false';

      const config = loadRateLimitConfig();

      expect(config.enabled).toBe(false);
    });

    it('should disable rate limiting when RATE_LIMIT_ENABLED is 0', () => {
      process.env.RATE_LIMIT_ENABLED = '0';

      const config = loadRateLimitConfig();

      expect(config.enabled).toBe(false);
    });

    it('should be case insensitive for RATE_LIMIT_ENABLED', () => {
      process.env.RATE_LIMIT_ENABLED = 'FALSE';

      const config = loadRateLimitConfig();

      expect(config.enabled).toBe(false);
    });
  });

  describe('RateLimiter', () => {
    describe('checkLimit', () => {
      it('should allow requests under the limit', () => {
        const limiter = new RateLimiter({ windowMs: 60000, maxRequests: 5, enabled: true });

        const result = limiter.checkLimit();

        expect(result.allowed).toBe(true);
        expect(result.remaining).toBe(4);
        expect(result.limit).toBe(5);

        limiter.destroy();
      });

      it('should decrement remaining count with each request', () => {
        const limiter = new RateLimiter({ windowMs: 60000, maxRequests: 3, enabled: true });

        expect(limiter.checkLimit().remaining).toBe(2);
        expect(limiter.checkLimit().remaining).toBe(1);
        expect(limiter.checkLimit().remaining).toBe(0);

        limiter.destroy();
      });

      it('should block requests when limit exceeded', () => {
        const limiter = new RateLimiter({ windowMs: 60000, maxRequests: 2, enabled: true });

        limiter.checkLimit(); // 1
        limiter.checkLimit(); // 2

        const result = limiter.checkLimit(); // 3 - should be blocked

        expect(result.allowed).toBe(false);
        expect(result.remaining).toBe(0);
        expect(result.retryAfterSeconds).toBeGreaterThan(0);

        limiter.destroy();
      });

      it('should always allow when disabled', () => {
        const limiter = new RateLimiter({ windowMs: 60000, maxRequests: 1, enabled: false });

        const result1 = limiter.checkLimit();
        const result2 = limiter.checkLimit();
        const result3 = limiter.checkLimit();

        expect(result1.allowed).toBe(true);
        expect(result2.allowed).toBe(true);
        expect(result3.allowed).toBe(true);

        limiter.destroy();
      });

      it('should track different keys separately', () => {
        const limiter = new RateLimiter({ windowMs: 60000, maxRequests: 2, enabled: true });

        limiter.checkLimit('client1');
        limiter.checkLimit('client1');
        const client1Result = limiter.checkLimit('client1'); // blocked

        const client2Result = limiter.checkLimit('client2'); // allowed

        expect(client1Result.allowed).toBe(false);
        expect(client2Result.allowed).toBe(true);
        expect(client2Result.remaining).toBe(1);

        limiter.destroy();
      });

      it('should reset window after expiry', async () => {
        const limiter = new RateLimiter({ windowMs: 50, maxRequests: 1, enabled: true });

        limiter.checkLimit(); // use up the limit
        const blocked = limiter.checkLimit();
        expect(blocked.allowed).toBe(false);

        // Wait for window to expire
        await new Promise((resolve) => setTimeout(resolve, 60));

        const afterExpiry = limiter.checkLimit();
        expect(afterExpiry.allowed).toBe(true);
        expect(afterExpiry.remaining).toBe(0);

        limiter.destroy();
      });
    });

    describe('getStatus', () => {
      it('should return status without incrementing counter', () => {
        const limiter = new RateLimiter({ windowMs: 60000, maxRequests: 5, enabled: true });

        limiter.checkLimit(); // count: 1

        const status1 = limiter.getStatus();
        const status2 = limiter.getStatus();

        expect(status1.remaining).toBe(4);
        expect(status2.remaining).toBe(4); // same, not decremented

        limiter.destroy();
      });

      it('should return full capacity for new windows', () => {
        const limiter = new RateLimiter({ windowMs: 60000, maxRequests: 10, enabled: true });

        const status = limiter.getStatus('newclient');

        expect(status.remaining).toBe(10);
        expect(status.allowed).toBe(true);

        limiter.destroy();
      });
    });

    describe('formatError', () => {
      it('should format error response correctly', () => {
        const limiter = new RateLimiter({ windowMs: 60000, maxRequests: 1, enabled: true });

        limiter.checkLimit();
        const result = limiter.checkLimit(); // blocked

        const error = limiter.formatError(result);

        expect(error.error).toContain('Rate limit exceeded');
        expect(error.waitTimeSeconds).toBeGreaterThan(0);
        expect(error.limit).toBe(1);
        expect(error.windowMs).toBe(60000);

        limiter.destroy();
      });
    });

    describe('reset', () => {
      it('should reset limit for specific key', () => {
        const limiter = new RateLimiter({ windowMs: 60000, maxRequests: 1, enabled: true });

        limiter.checkLimit('client1');
        expect(limiter.checkLimit('client1').allowed).toBe(false);

        limiter.reset('client1');

        expect(limiter.checkLimit('client1').allowed).toBe(true);

        limiter.destroy();
      });
    });

    describe('resetAll', () => {
      it('should reset all limits', () => {
        const limiter = new RateLimiter({ windowMs: 60000, maxRequests: 1, enabled: true });

        limiter.checkLimit('client1');
        limiter.checkLimit('client2');

        limiter.resetAll();

        expect(limiter.checkLimit('client1').allowed).toBe(true);
        expect(limiter.checkLimit('client2').allowed).toBe(true);

        limiter.destroy();
      });
    });
  });

  describe('Singleton', () => {
    it('should return same instance on multiple calls', () => {
      const instance1 = getRateLimiter();
      const instance2 = getRateLimiter();

      expect(instance1).toBe(instance2);
    });

    it('should create new instance after reset', () => {
      const instance1 = getRateLimiter();
      resetRateLimiterInstance();
      const instance2 = getRateLimiter();

      expect(instance1).not.toBe(instance2);
    });
  });
});
