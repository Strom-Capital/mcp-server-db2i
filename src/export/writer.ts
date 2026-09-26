/**
 * Shared parts of the export file writers: the column shape they write, the
 * interface both formats implement, and a file sink that counts bytes and
 * waits when the disk falls behind.
 */

import { createWriteStream, type WriteStream } from 'node:fs';
import { once } from 'node:events';
import type { ColumnKind } from '../db/driver.js';

/** A result column as a writer sees it. */
export interface ExportColumn {
  /** Header text. */
  name: string;
  kind: ColumnKind;
  /** Masked values are text whatever the column type, so they are written as text. */
  masked: boolean;
}

/** One export file being written. Rows arrive in column order. */
export interface ExportWriter {
  /** Bytes written to the file so far. */
  readonly bytes: number;
  /** Bytes of content before compression. Equal to `bytes` for CSV. */
  readonly rawBytes: number;
  writeHeader(columns: readonly ExportColumn[]): Promise<void>;
  writeRows(rows: readonly unknown[][]): Promise<void>;
  /** Write the end of the file and close it. */
  finish(): Promise<void>;
  /** Close the file without finishing it. The caller removes it. */
  abort(): Promise<void>;
}

/**
 * A new file opened for writing, readable only by this user. Fails when the
 * file already exists.
 */
export class FileSink {
  private readonly stream: WriteStream;
  private opened: Promise<void>;
  private failure: Error | undefined;
  bytes = 0;

  constructor(path: string) {
    this.stream = createWriteStream(path, { flags: 'wx', mode: 0o600 });
    this.stream.on('error', (error) => {
      this.failure = error;
    });
    this.opened = once(this.stream, 'open').then(() => undefined);
    // An open failure is reported by the first write or close
    this.opened.catch(() => undefined);
  }

  /** Write a chunk, and wait for the stream to drain when its buffer is full. */
  async write(chunk: string | Uint8Array): Promise<void> {
    await this.opened;
    if (this.failure) {
      throw this.failure;
    }
    const data = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
    this.bytes += data.byteLength;
    if (!this.stream.write(data)) {
      await once(this.stream, 'drain');
    }
  }

  /** Flush and close the file. */
  async end(): Promise<void> {
    await this.opened;
    if (this.failure) {
      throw this.failure;
    }
    this.stream.end();
    await once(this.stream, 'finish');
  }

  /** Close the file at once. Never throws. */
  async destroy(): Promise<void> {
    if (this.stream.closed) {
      return;
    }
    const closed = once(this.stream, 'close').catch(() => undefined);
    this.stream.destroy();
    await closed;
  }
}
