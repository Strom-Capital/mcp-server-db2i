/**
 * Stdio transport that reports when its client goes away.
 *
 * `serveStdio` sets the transport's `onclose` for its own bookkeeping, and the
 * handle it returns has no close hook. The SDK transport calls `close()` when
 * stdin ends or closes, and when writing to stdout fails because the client is
 * gone, so overriding `close()` catches every way the client can disappear.
 */

import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import type { Readable, Writable } from 'node:stream';

export class ClientAwareStdioTransport extends StdioServerTransport {
  private clientGoneFired = false;

  /**
   * @param onClientGone Called once, after the transport has closed. A close
   *   the server started itself also calls it, so the handler must be idempotent.
   * @param stdin Defaults to `process.stdin`.
   * @param stdout Defaults to `process.stdout`.
   */
  constructor(
    private readonly onClientGone: () => void,
    stdin?: Readable,
    stdout?: Writable
  ) {
    super(stdin, stdout);
  }

  override async close(): Promise<void> {
    await super.close();
    if (!this.clientGoneFired) {
      this.clientGoneFired = true;
      this.onClientGone();
    }
  }
}
