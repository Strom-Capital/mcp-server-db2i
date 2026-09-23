/**
 * Tests for HTTP session ownership helpers
 */

import { describe, it, expect } from 'vitest';
import {
  GLOBAL_SESSION_KEY,
  resolveCallerSessionKey,
  isSessionOwnedByCaller,
} from '../src/transports/sessionAuth.js';

describe('resolveCallerSessionKey', () => {
  it('returns the shared key for none and token modes', () => {
    expect(resolveCallerSessionKey('none', 'secret')).toBe(GLOBAL_SESSION_KEY);
    expect(resolveCallerSessionKey('token', 'secret')).toBe(GLOBAL_SESSION_KEY);
  });

  it('returns the auth token in required mode', () => {
    expect(resolveCallerSessionKey('required', 'user-token')).toBe('user-token');
  });

  it('returns empty string when required mode has no token', () => {
    expect(resolveCallerSessionKey('required')).toBe('');
  });
});

describe('isSessionOwnedByCaller', () => {
  it('accepts a matching token', () => {
    expect(isSessionOwnedByCaller('user-a', 'user-a')).toBe(true);
  });

  it('rejects a different token', () => {
    expect(isSessionOwnedByCaller('user-a', 'user-b')).toBe(false);
  });
});
