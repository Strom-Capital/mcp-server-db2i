import { PassThrough, Writable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';

import { ClientAwareStdioTransport } from '../src/transports/stdio.js';

function streams(): { stdin: PassThrough; stdout: PassThrough } {
  return { stdin: new PassThrough(), stdout: new PassThrough() };
}

describe('ClientAwareStdioTransport', () => {
  it('reports the client gone once when stdin ends', async () => {
    const { stdin, stdout } = streams();
    const onClientGone = vi.fn();
    const transport = new ClientAwareStdioTransport(onClientGone, stdin, stdout);
    await transport.start();

    stdin.end();
    stdin.resume();
    await vi.waitFor(() => expect(onClientGone).toHaveBeenCalled());
    await transport.close();

    expect(onClientGone).toHaveBeenCalledOnce();
  });

  it('reports the client gone when stdin is destroyed', async () => {
    const { stdin, stdout } = streams();
    const onClientGone = vi.fn();
    const transport = new ClientAwareStdioTransport(onClientGone, stdin, stdout);
    await transport.start();

    stdin.destroy();
    await vi.waitFor(() => expect(onClientGone).toHaveBeenCalledOnce());
  });

  it('reports the client gone when stdout breaks', async () => {
    const stdin = new PassThrough();
    const stdout = new Writable({
      write(_chunk, _encoding, callback) {
        callback(Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }));
      },
    });
    const onClientGone = vi.fn();
    const transport = new ClientAwareStdioTransport(onClientGone, stdin, stdout);
    transport.onerror = () => {};
    await transport.start();

    await transport.send({ jsonrpc: '2.0', method: 'notifications/message', params: {} }).catch(() => {});
    await vi.waitFor(() => expect(onClientGone).toHaveBeenCalledOnce());
  });

  it('reports the client gone through serveStdio', async () => {
    const { stdin, stdout } = streams();
    const onClientGone = vi.fn();
    const handle = serveStdio(
      () => new McpServer({ name: 'test', version: '0.0.0' }),
      { transport: new ClientAwareStdioTransport(onClientGone, stdin, stdout) }
    );

    stdin.end();
    stdin.resume();
    await vi.waitFor(() => expect(onClientGone).toHaveBeenCalledOnce());
    await handle.close();

    expect(onClientGone).toHaveBeenCalledOnce();
  });
});
