'use client';

import { useState } from 'react';
import { useAppState } from '@/components/app-state';
import { formatBytes } from '@/components/result-parts';
import { useNow } from '@/lib/client/clock';
import { runTool, SignInNeededError } from '@/lib/client/run-tool';
import { clearExpiredExports, useExports, type ExportEntry } from '@/lib/client/store';
import { countOf, timeLeft } from '@/lib/format';
import { readToolResult } from '@/lib/results';

function isExpired(entry: ExportEntry, now: number): boolean {
  return !!entry.expiresAt && now > 0 && Date.parse(entry.expiresAt) <= now;
}

/** Files that export_query wrote, from the chat and from direct runs, with their download links. */
export default function ExportsPage() {
  const { items, loading } = useExports();
  const { refreshSession } = useAppState();
  const now = useNow();
  const [busy, setBusy] = useState<string>();
  const [errors, setErrors] = useState<Record<string, string>>({});
  const expiredCount = items.filter((entry) => isExpired(entry, now)).length;

  async function exportAgain(entry: ExportEntry) {
    if (!entry.input) {
      return;
    }
    setBusy(entry.url);
    setErrors((current) => ({ ...current, [entry.url]: '' }));
    try {
      const run = await runTool(entry.tool, entry.input);
      const view = readToolResult(run.output);
      if (!view.exportFile) {
        setErrors((current) => ({ ...current, [entry.url]: view.error?.message ?? 'The tool did not write a file.' }));
      }
    } catch (error) {
      if (error instanceof SignInNeededError) {
        refreshSession();
      }
      setErrors((current) => ({ ...current, [entry.url]: error instanceof Error ? error.message : 'The export failed.' }));
    } finally {
      setBusy(undefined);
    }
  }

  return (
    <div className="mx-auto h-full max-w-5xl overflow-y-auto px-4 py-6">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-semibold">Exports</h1>
        <span className="text-sm text-muted-foreground">
          Excel and CSV files the server wrote for you. Links expire and allow a few downloads; export again to get a new one.
        </span>
        <span className="flex-1" />
        {expiredCount > 0 && (
          <button
            type="button"
            onClick={() => void clearExpiredExports()}
            className="h-9 rounded-sm border border-line px-3 text-sm hover:border-fg"
          >
            Clear {expiredCount} expired
          </button>
        )}
      </div>

      {!loading && items.length === 0 && (
        <p className="mt-10 text-center text-muted-foreground">
          No exports yet. Ask the chat to export a query to Excel, or run export_query on the Tools page.
        </p>
      )}

      <ul className="mt-4 flex flex-col gap-3">
        {items.map((entry) => {
          const expired = isExpired(entry, now);
          return (
            <li key={entry.url} className={`rounded-sm border border-line bg-surface/60 ${expired ? 'opacity-70' : ''}`}>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-sm">
                <span className="font-medium">{entry.filename}</span>
                <span className="text-muted-foreground tabular">
                  {[
                    new Date(entry.at).toLocaleString(),
                    entry.rowCount !== undefined ? countOf(entry.rowCount, 'row') : undefined,
                    entry.bytes !== undefined ? formatBytes(entry.bytes) : undefined,
                    entry.downloadsAllowed !== undefined ? `${countOf(entry.downloadsAllowed, 'download')} allowed` : undefined,
                  ]
                    .filter(Boolean)
                    .join(' \u00b7 ')}
                </span>
                {entry.truncated && <span className="text-error">Stopped at the {entry.truncated === 'rows' ? 'row' : 'size'} limit</span>}
                <span className="flex-1" />
                {entry.expiresAt && now > 0 && (
                  <span className={expired ? 'text-muted-foreground' : 'tabular'}>{expired ? 'Expired' : `Expires ${timeLeft(entry.expiresAt, now)}`}</span>
                )}
                {entry.input && (
                  <button
                    type="button"
                    disabled={busy === entry.url}
                    onClick={() => void exportAgain(entry)}
                    className="rounded-sm border border-line px-2 py-1 hover:border-fg disabled:opacity-50"
                  >
                    {busy === entry.url ? 'Exporting' : 'Export again'}
                  </button>
                )}
                {!expired && (
                  <a href={entry.url} rel="noreferrer" className="rounded-sm bg-accent px-3 py-1 font-medium text-on-accent hover:bg-accent-strong">
                    Download
                  </a>
                )}
              </div>
              {entry.sql && (
                <pre className="mx-3 mb-3 max-h-32 overflow-auto rounded-sm bg-bg p-2 font-mono text-xs whitespace-pre-wrap">{entry.sql}</pre>
              )}
              {errors[entry.url] && <p className="mx-3 mb-3 text-sm text-error">{errors[entry.url]}</p>}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
