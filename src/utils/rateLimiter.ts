/**
 * Rate Limiter Module
 *
 * Implements a fixed window rate limiting algorithm to prevent
 * abuse and protect the IBM i database from excessive queries.
 */

import { DEFAULT_RATE_LIMIT, type RateLimitConfig } from '../config.js';
import { createChildLogger } from './logger.js';

const log = createChildLogger({ component: 'rate-limiter' });

// Re-export for consumers
export type { RateLimitConfig };

/**
 * Result of a rate limit check
 */
export interface RateLimitResult {
  /** Whether the request is allowed */
  allowed: boolean;
  /** Number of requests remaining in current window */
  remaining: number;
  /** Timestamp when the window resets (ms since epoch) */
  resetTime: number;
  /** Seconds until the window resets */
  retryAfterSeconds: number;
  /** The configured limit */
  limit: number;
  /** The configured window in ms */
  windowMs: number;
}

/**
 * Rate limit error response format (matches issue spec)
 */
export interface RateLimitError {
  error: string;
  waitTimeSeconds: number;
  limit: number;
  windowMs: number;
}

/**
 * Internal tracking for a rate limit window
 */
interface WindowData {
  count: number;
  windowStart: number;
}

/**
 * Load rate limit configuration from environment variables
 */
export function loadRateLimitConfig(): RateLimitConfig {
  const windowMs = process.env.RATE_LIMIT_WINDOW_MS
    ? parseInt(process.env.RATE_LIMIT_WINDOW_MS, 10)
    : DEFAULT_RATE_LIMIT.windowMs;

  const maxRequests = process.env.RATE_LIMIT_MAX_REQUESTS
    ? parseInt(process.env.RATE_LIMIT_MAX_REQUESTS, 10)
    : DEFAULT_RATE_LIMIT.maxRequests;

  // Disabled if explicitly set to 'false' or '0'
  const enabledEnv = process.env.RATE_LIMIT_ENABLED?.toLowerCase();
  const enabled = enabledEnv !== 'false' && enabledEnv !== '0';

  return { windowMs, maxRequests, enabled };
}

/**
 * Rate Limiter class implementing fixed window algorithm
 */
export class RateLimiter {
  private config: RateLimitConfig;
  private windows: Map<string, WindowData> = new Map();
  private cleanupInterval: NodeJS.Timeout | null = null;

  constructor(config: Partial<RateLimitConfig> = {}) {
    this.config = { ...DEFAULT_RATE_LIMIT, ...config };

    if (this.config.enabled) {
      // Run cleanup every window period to prevent memory leaks
      this.cleanupInterval = setInterval(
        () => this.cleanup(),
        this.config.windowMs
      );
      // Don't keep process alive just for cleanup
      this.cleanupInterval.unref();

      log.debug(
        { windowMs: this.config.windowMs, maxRequests: this.config.maxRequests },
        'Rate limiter initialized'
      );
    } else {
      log.info('Rate limiting is disabled');
    }
  }

  /**
   * Check if a request is allowed under the rate limit
   *
   * @param key - Unique identifier for the client (default: 'default')
   * @returns Rate limit check result
   */
  checkLimit(key: string = 'default'): RateLimitResult {
    const now = Date.now();

    // If disabled, always allow
    if (!this.config.enabled) {
      return {
        allowed: true,
        remaining: this.config.maxRequests,
        resetTime: now + this.config.windowMs,
        retryAfterSeconds: 0,
        limit: this.config.maxRequests,
        windowMs: this.config.windowMs,
      };
    }

    let window = this.windows.get(key);

    // Create new window or reset expired window
    if (!window || now >= window.windowStart + this.config.windowMs) {
      window = {
        count: 0,
        windowStart: now,
      };
      this.windows.set(key, window);
    }

    const resetTime = window.windowStart + this.config.windowMs;
    const retryAfterSeconds = Math.ceil((resetTime - now) / 1000);

    // Check if limit exceeded
    if (window.count >= this.config.maxRequests) {
      log.warn(
        { key, count: window.count, limit: this.config.maxRequests, retryAfterSeconds },
        'Rate limit exceeded'
      );

      return {
        allowed: false,
        remaining: 0,
        resetTime,
        retryAfterSeconds,
        limit: this.config.maxRequests,
        windowMs: this.config.windowMs,
      };
    }

    // Increment count and allow
    window.count++;

    const remaining = this.config.maxRequests - window.count;

    log.debug(
      { key, count: window.count, remaining, limit: this.config.maxRequests },
      'Rate limit check passed'
    );

    return {
      allowed: true,
      remaining,
      resetTime,
      retryAfterSeconds,
      limit: this.config.maxRequests,
      windowMs: this.config.windowMs,
    };
  }

  /**
   * Get current rate limit status without incrementing counter
   *
   * @param key - Unique identifier for the client
   * @returns Current rate limit status
   */
  getStatus(key: string = 'default'): RateLimitResult {
    const now = Date.now();

    if (!this.config.enabled) {
      return {
        allowed: true,
        remaining: this.config.maxRequests,
        resetTime: now + this.config.windowMs,
        retryAfterSeconds: 0,
        limit: this.config.maxRequests,
        windowMs: this.config.windowMs,
      };
    }

    const window = this.windows.get(key);

    if (!window || now >= window.windowStart + this.config.windowMs) {
      return {
        allowed: true,
        remaining: this.config.maxRequests,
        resetTime: now + this.config.windowMs,
        retryAfterSeconds: 0,
        limit: this.config.maxRequests,
        windowMs: this.config.windowMs,
      };
    }

    const resetTime = window.windowStart + this.config.windowMs;
    const remaining = Math.max(0, this.config.maxRequests - window.count);

    return {
      allowed: remaining > 0,
      remaining,
      resetTime,
      retryAfterSeconds: Math.ceil((resetTime - now) / 1000),
      limit: this.config.maxRequests,
      windowMs: this.config.windowMs,
    };
  }

  /**
   * Format a rate limit error response
   */
  formatError(result: RateLimitResult): RateLimitError {
    return {
      error: `Rate limit exceeded. Please try again in ${result.retryAfterSeconds} seconds.`,
      waitTimeSeconds: result.retryAfterSeconds,
      limit: result.limit,
      windowMs: result.windowMs,
    };
  }

  /**
   * Reset the rate limit for a specific key (useful for testing)
   */
  reset(key: string = 'default'): void {
    this.windows.delete(key);
    log.debug({ key }, 'Rate limit reset');
  }

  /**
   * Reset all rate limits
   */
  resetAll(): void {
    this.windows.clear();
    log.debug('All rate limits reset');
  }

  /**
   * Clean up expired windows to prevent memory leaks
   */
  private cleanup(): void {
    const now = Date.now();
    let cleaned = 0;

    for (const [key, window] of this.windows.entries()) {
      if (now >= window.windowStart + this.config.windowMs) {
        this.windows.delete(key);
        cleaned++;
      }
    }

    if (cleaned > 0) {
      log.debug({ cleaned, remaining: this.windows.size }, 'Cleaned up expired rate limit windows');
    }
  }

  /**
   * Stop the cleanup interval (call when shutting down)
   */
  destroy(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
  }
}

/**
 * Singleton rate limiter instance
 * Initialized with environment config
 */
let rateLimiterInstance: RateLimiter | null = null;

/**
 * Get the singleton rate limiter instance
 */
export function getRateLimiter(): RateLimiter {
  if (!rateLimiterInstance) {
    const config = loadRateLimitConfig();
    rateLimiterInstance = new RateLimiter(config);
  }
  return rateLimiterInstance;
}

/**
 * Reset the singleton instance (useful for testing)
 */
export function resetRateLimiterInstance(): void {
  if (rateLimiterInstance) {
    rateLimiterInstance.destroy();
    rateLimiterInstance = null;
  }
}
