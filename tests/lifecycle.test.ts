import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/utils/auditLog.js', () => ({
  writeAuditEvent: vi.fn(),
  closeAuditLog: vi.fn(),
}));
vi.mock('../src/customTools/watch.js', () => ({
  stopCustomToolsWatch: vi.fn(),
}));

import { createLifecycle, SHUTDOWN_DEADLINE_MS, type LifecycleOptions } from '../src/lifecycle.js';
import { closeAuditLog, writeAuditEvent } from '../src/utils/auditLog.js';
import { stopCustomToolsWatch } from '../src/customTools/watch.js';

function options(overrides: Partial<LifecycleOptions> = {}): LifecycleOptions {
  return {
    httpEnabled: false,
    closeStdioPools: vi.fn(() => Promise.resolve()),
    pendingPools: vi.fn(() => []),
    exit: vi.fn(),
    ...overrides,
  };
}

/** A promise that never settles, like a pool close waiting on a running statement. */
function hang(): Promise<void> {
  return new Promise(() => {});
}

describe('shutdown', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('closes both transports and the stdio pools, then exits 0', async () => {
    const opts = options();
    const lifecycle = createLifecycle(opts);
    const closeStdio = vi.fn(() => Promise.resolve());
    const closeHttp = vi.fn(() => Promise.resolve());
    lifecycle.setStdio(closeStdio);
    lifecycle.setHttp(closeHttp);

    await lifecycle.shutdown('SIGTERM');

    expect(closeStdio).toHaveBeenCalledOnce();
    expect(closeHttp).toHaveBeenCalledOnce();
    expect(opts.closeStdioPools).toHaveBeenCalledOnce();
    expect(stopCustomToolsWatch).toHaveBeenCalledOnce();
    expect(writeAuditEvent).toHaveBeenCalledWith({ event: 'shutdown', reason: 'SIGTERM' });
    expect(closeAuditLog).toHaveBeenCalledOnce();
    expect(opts.exit).toHaveBeenCalledExactlyOnceWith(0);
  });

  it('runs once when called again', async () => {
    const opts = options();
    const lifecycle = createLifecycle(opts);
    const closeStdio = vi.fn(() => Promise.resolve());
    lifecycle.setStdio(closeStdio);

    const first = lifecycle.shutdown('SIGINT');
    const second = lifecycle.shutdown('SIGTERM');
    expect(second).toBe(first);
    await first;

    expect(closeStdio).toHaveBeenCalledOnce();
    expect(opts.closeStdioPools).toHaveBeenCalledOnce();
    expect(writeAuditEvent).toHaveBeenCalledOnce();
    expect(opts.exit).toHaveBeenCalledOnce();
  });

  it('still closes the pools when a transport fails to close', async () => {
    const opts = options();
    const lifecycle = createLifecycle(opts);
    lifecycle.setStdio(() => Promise.reject(new Error('boom')));

    await lifecycle.shutdown('SIGTERM');

    expect(opts.closeStdioPools).toHaveBeenCalledOnce();
    expect(opts.exit).toHaveBeenCalledExactlyOnceWith(0);
  });

  it('exits 1 at the deadline when a pool never closes, naming the pools', async () => {
    vi.useFakeTimers();
    const opts = options({
      closeStdioPools: vi.fn(hang),
      pendingPools: vi.fn(() => ['Global connection pool (default)']),
    });
    const lifecycle = createLifecycle(opts);

    void lifecycle.shutdown('SIGTERM');
    await vi.advanceTimersByTimeAsync(SHUTDOWN_DEADLINE_MS - 1);
    expect(opts.exit).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(opts.pendingPools).toHaveBeenCalled();
    expect(writeAuditEvent).toHaveBeenLastCalledWith({ event: 'shutdown', reason: 'deadline' });
    expect(closeAuditLog).toHaveBeenCalledOnce();
    expect(opts.exit).toHaveBeenCalledExactlyOnceWith(1);
  });

  it('exits 1 at the deadline when a transport never closes', async () => {
    vi.useFakeTimers();
    const opts = options({ deadlineMs: 100 });
    const lifecycle = createLifecycle(opts);
    lifecycle.setHttp(hang);

    void lifecycle.shutdown('SIGINT');
    await vi.advanceTimersByTimeAsync(100);

    expect(opts.closeStdioPools).not.toHaveBeenCalled();
    expect(opts.exit).toHaveBeenCalledExactlyOnceWith(1);
  });

  it('does not exit twice when the close finishes after the deadline', async () => {
    vi.useFakeTimers();
    let release: () => void = () => {};
    const opts = options({
      deadlineMs: 100,
      closeStdioPools: vi.fn(() => new Promise<void>((resolve) => { release = resolve; })),
    });
    const lifecycle = createLifecycle(opts);

    const done = lifecycle.shutdown('SIGTERM');
    await vi.advanceTimersByTimeAsync(100);
    release();
    await done;

    expect(opts.exit).toHaveBeenCalledExactlyOnceWith(1);
  });
});

describe('stdio client going away', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shuts the server down when only stdio is enabled', async () => {
    const opts = options();
    const lifecycle = createLifecycle(opts);
    lifecycle.setStdio(vi.fn(() => Promise.resolve()));

    lifecycle.onStdioClientGone();
    await vi.waitFor(() => expect(opts.exit).toHaveBeenCalled());

    expect(writeAuditEvent).toHaveBeenCalledWith({ event: 'shutdown', reason: 'stdin closed' });
    expect(opts.closeStdioPools).toHaveBeenCalledOnce();
    expect(opts.exit).toHaveBeenCalledExactlyOnceWith(0);
  });

  it('keeps HTTP running in both mode and closes only the stdio pools', async () => {
    const opts = options({ httpEnabled: true });
    const lifecycle = createLifecycle(opts);
    const closeHttp = vi.fn(() => Promise.resolve());
    lifecycle.setHttp(closeHttp);

    lifecycle.onStdioClientGone();
    lifecycle.onStdioClientGone();
    await Promise.resolve();

    expect(opts.closeStdioPools).toHaveBeenCalledOnce();
    expect(closeHttp).not.toHaveBeenCalled();
    expect(writeAuditEvent).not.toHaveBeenCalled();
    expect(opts.exit).not.toHaveBeenCalled();
  });

  it('keeps HTTP running when stdin closes before HTTP has started', async () => {
    const opts = options({ httpEnabled: true });
    const lifecycle = createLifecycle(opts);

    lifecycle.onStdioClientGone();
    await Promise.resolve();

    expect(opts.exit).not.toHaveBeenCalled();
  });

  it('does not close the stdio transport again on a later signal in both mode', async () => {
    const opts = options({ httpEnabled: true });
    const lifecycle = createLifecycle(opts);
    const closeStdio = vi.fn(() => Promise.resolve());
    lifecycle.setStdio(closeStdio);
    lifecycle.setHttp(vi.fn(() => Promise.resolve()));

    lifecycle.onStdioClientGone();
    await lifecycle.shutdown('SIGTERM');

    expect(closeStdio).not.toHaveBeenCalled();
    expect(opts.exit).toHaveBeenCalledExactlyOnceWith(0);
  });

  it('is ignored while a shutdown is already running', async () => {
    const opts = options();
    const lifecycle = createLifecycle(opts);
    // Shutdown closes the transport, which reports the client gone
    lifecycle.setStdio(() => {
      lifecycle.onStdioClientGone();
      return Promise.resolve();
    });

    await lifecycle.shutdown('SIGTERM');

    expect(writeAuditEvent).toHaveBeenCalledExactlyOnceWith({ event: 'shutdown', reason: 'SIGTERM' });
    expect(opts.exit).toHaveBeenCalledOnce();
  });
});
