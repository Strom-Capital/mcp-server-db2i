/**
 * Session manager for the deprecated stateful HTTP mode: stale-session
 * cleanup, active request counting, and closing sessions.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/server';
import { getSessionManager, type SessionManager } from '../src/transports/sessionManager.js';

const STALE_MS = 30 * 60 * 1000;

function fakeServer(connect: () => Promise<void> = async () => undefined) {
  return {
    connect: vi.fn(connect),
    close: vi.fn(async () => undefined),
  };
}

describe('SessionManager', () => {
  let manager: SessionManager;

  // The sweep runs from a timer the singleton starts once, and shutdown() in
  // afterEach stops it, so these tests call the sweep directly.
  function sweep(): Promise<void> {
    return (manager as unknown as { cleanupStaleSessions(): Promise<void> }).cleanupStaleSessions();
  }

  async function open(authToken: string) {
    const server = fakeServer();
    const { sessionId } = await manager.createSession(server as unknown as McpServer, authToken);
    return { sessionId, server };
  }

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    manager = getSessionManager();
  });

  afterEach(async () => {
    await manager.shutdown();
    vi.useRealTimers();
  });

  it('closes a session idle past the stale timeout and keeps a recent one', async () => {
    const idle = await open('token-a');
    vi.setSystemTime(Date.now() + STALE_MS - 1000);
    const recent = await open('token-b');

    vi.setSystemTime(Date.now() + 2000);
    await sweep();

    expect(manager.hasSession(idle.sessionId)).toBe(false);
    expect(idle.server.close).toHaveBeenCalled();
    expect(manager.hasSession(recent.sessionId)).toBe(true);
    expect(recent.server.close).not.toHaveBeenCalled();
  });

  it('keeps a stale session while a request is running, and closes it once the request ends', async () => {
    const { sessionId } = await open('token-a');
    manager.incrementActiveRequests(sessionId);

    vi.setSystemTime(Date.now() + STALE_MS + 1000);
    await sweep();
    expect(manager.hasSession(sessionId)).toBe(true);

    // Ending the request counts as activity, so the session is fresh again
    manager.decrementActiveRequests(sessionId);
    await sweep();
    expect(manager.hasSession(sessionId)).toBe(true);

    vi.setSystemTime(Date.now() + STALE_MS + 1000);
    await sweep();
    expect(manager.hasSession(sessionId)).toBe(false);
  });

  it('does not count active requests below zero', async () => {
    const { sessionId } = await open('token-a');
    manager.decrementActiveRequests(sessionId);
    manager.incrementActiveRequests(sessionId);
    manager.decrementActiveRequests(sessionId);

    vi.setSystemTime(Date.now() + STALE_MS + 1000);
    await sweep();

    expect(manager.hasSession(sessionId)).toBe(false);
  });

  it('reports active and stale sessions', async () => {
    await open('token-a');
    vi.setSystemTime(Date.now() + STALE_MS + 1000);
    await open('token-b');

    expect(manager.getStats()).toEqual({ totalSessions: 2, activeSessions: 1, staleSessions: 1 });
  });

  it('closes only the sessions of the given token', async () => {
    const first = await open('token-a');
    const second = await open('token-a');
    const other = await open('token-b');

    expect(await manager.closeSessionsByToken('token-a')).toBe(2);

    expect(manager.hasSession(first.sessionId)).toBe(false);
    expect(manager.hasSession(second.sessionId)).toBe(false);
    expect(manager.hasSession(other.sessionId)).toBe(true);
  });

  it('closes the server and drops the session even when the transport fails to close', async () => {
    const { sessionId, server } = await open('token-a');
    const session = manager.getSession(sessionId)!;
    vi.spyOn(session.transport, 'close').mockRejectedValueOnce(new Error('socket gone'));

    expect(await manager.closeSession(sessionId)).toBe(true);

    expect(server.close).toHaveBeenCalled();
    expect(manager.hasSession(sessionId)).toBe(false);
    expect(await manager.closeSession(sessionId)).toBe(false);
  });

  it('stores no session when the server fails to connect', async () => {
    const server = fakeServer(async () => {
      throw new Error('connect failed');
    });

    await expect(manager.createSession(server as unknown as McpServer, 'token-a')).rejects.toThrow('connect failed');

    expect(manager.getStats().totalSessions).toBe(0);
  });
});
