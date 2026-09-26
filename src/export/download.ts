/**
 * GET and HEAD /exports/:id: the download link export_query returns in HTTP
 * mode.
 *
 * The route has no bearer check. The link is the credential: its id is 256
 * random bits, it is only found in the in-memory registry, and it expires. A
 * browser following the link from a chat cannot send the MCP token anyway.
 * HEAD answers from the registry without counting as a download, so a link
 * preview that checks with HEAD does not spend one.
 */

import { createReadStream } from 'node:fs';
import type { Request, Response } from 'express';
import { writeAuditEvent } from '../utils/auditLog.js';
import { createChildLogger } from '../utils/logger.js';
import {
  deleteExportFile,
  EXPORT_CONTENT_TYPES,
  peekExport,
  takeExport,
  type ExportEntry,
} from './store.js';

const log = createChildLogger({ component: 'export-download' });

const GONE_MESSAGE = 'This download link has expired or has been used as many times as allowed. Ask for the export again.';

/** The first characters of an id, enough to match audit lines, too few to use. */
function idPrefix(id: string): string {
  return id.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 8);
}

function setDownloadHeaders(res: Response, entry: ExportEntry): void {
  res.setHeader('Content-Type', EXPORT_CONTENT_TYPES[entry.format]);
  res.setHeader('Content-Length', String(entry.bytes));
  // The name is already limited to [A-Za-z0-9._-], so it needs no quoting rules
  res.setHeader('Content-Disposition', `attachment; filename="${entry.filename}"`);
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'");
  res.setHeader('X-Robots-Tag', 'noindex');
}

function notFound(res: Response): void {
  res.setHeader('Cache-Control', 'no-store');
  res.status(404).type('text/plain').send(GONE_MESSAGE);
}

/**
 * Send an export file. Every GET counts as a download. The last allowed one
 * removes the link before the first byte is sent, and its file is deleted when
 * the response ends, whether or not the download completed.
 */
export function exportDownloadHandler(req: Request, res: Response): void {
  const id = String(req.params.id ?? '');
  const ip = req.ip;

  if (req.method === 'HEAD') {
    const entry = peekExport(id);
    if (!entry) {
      res.setHeader('Cache-Control', 'no-store');
      res.status(404).end();
      return;
    }
    setDownloadHeaders(res, entry);
    res.status(200).end();
    return;
  }

  const taken = takeExport(id);
  if (!taken) {
    writeAuditEvent({ event: 'export_download', exportId: idPrefix(id), identity: 'unknown', ip, outcome: 'not_found' });
    notFound(res);
    return;
  }

  const { entry, deleteAfter } = taken;
  const audit = (outcome: 'success' | 'error'): void => {
    writeAuditEvent({
      event: 'export_download',
      exportId: idPrefix(entry.id),
      identity: entry.owner,
      ip,
      outcome,
      bytes: entry.bytes,
      rowCount: entry.rows,
    });
  };

  let sending = false;
  const file = createReadStream(entry.path);
  file.on('error', (error) => {
    log.warn({ err: error, exportId: idPrefix(entry.id) }, 'Could not read export file');
    if (!res.headersSent) {
      notFound(res);
    } else {
      res.destroy(error);
    }
  });
  file.once('open', () => {
    sending = true;
    setDownloadHeaders(res, entry);
    res.status(200);
    file.pipe(res);
  });
  res.on('close', () => {
    file.destroy();
    // A download cut off midway, or a file that could not be read, is an error
    const ok = sending && res.writableFinished;
    audit(ok ? 'success' : 'error');
    if (ok) {
      log.info({ exportId: idPrefix(entry.id), bytes: entry.bytes }, 'Export downloaded');
    }
    if (deleteAfter) {
      void deleteExportFile(entry);
    }
  });
}
