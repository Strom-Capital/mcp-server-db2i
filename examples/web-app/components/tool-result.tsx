'use client';

import { useNow } from '@/lib/client/clock';
import { countOf, timeLeft } from '@/lib/format';
import { readToolResult, type ExportFile, type ToolError, type ToolResultView } from '@/lib/results';
import { ResultTable } from './result-table';

/**
 * A file size in B, KB or MB.
 *
 * @param bytes - Size in bytes
 * @returns Text such as `716.8 KB`
 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** Download button and details for an export_query file. */
export function ExportCard({ file }: { file: ExportFile }) {
  const now = useNow();
  const expired = file.expiresAt && now > 0 ? Date.parse(file.expiresAt) < now : false;
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-sm border border-border bg-card px-3 py-2 text-sm">
      <span className="font-medium">{file.filename}</span>
      <span className="text-muted-foreground tabular">
        {[
          file.rowCount !== undefined ? countOf(file.rowCount, 'row') : undefined,
          file.bytes !== undefined ? formatBytes(file.bytes) : undefined,
          file.expiresAt && now > 0 ? (expired ? 'expired' : `expires ${timeLeft(file.expiresAt, now)}`) : undefined,
          file.downloadsAllowed !== undefined ? countOf(file.downloadsAllowed, 'download') : undefined,
        ]
          .filter(Boolean)
          .join(' \u00b7 ')}
      </span>
      {file.truncated && <span className="text-destructive">Stopped at the {file.truncated === 'rows' ? 'row' : 'size'} limit</span>}
      <span className="flex-1" />
      {expired ? (
        <span className="text-muted-foreground">Link expired</span>
      ) : (
        <a
          href={file.url}
          className="rounded-sm bg-primary px-3 py-1.5 font-medium text-primary-foreground hover:bg-primary/90"
          rel="noreferrer"
        >
          Download
        </a>
      )}
    </div>
  );
}

/** A tool error with the Db2 SQLSTATE, cause and recovery text when the server sent them. */
export function ToolErrorBox({ error }: { error: ToolError }) {
  return (
    <div className="rounded-sm border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm">
      <p className="font-medium text-destructive">{error.message}</p>
      {(error.sqlstate || error.sqlcode !== undefined) && (
        <p className="mt-1 font-mono text-xs text-muted-foreground">
          {[error.sqlcode !== undefined ? `SQLCODE ${error.sqlcode}` : undefined, error.sqlstate ? `SQLSTATE ${error.sqlstate}` : undefined]
            .filter(Boolean)
            .join(' \u00b7 ')}
        </p>
      )}
      {error.cause && <p className="mt-1">{error.cause}</p>}
      {error.recovery && <p className="mt-1 text-muted-foreground">{error.recovery}</p>}
      {error.violations && error.violations.length > 0 && (
        <ul className="mt-1 list-disc pl-5">
          {error.violations.map((violation) => (
            <li key={violation}>{violation}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** One line under the tool name: row count, limit and duration. */
export function resultSummary(view: ToolResultView | undefined, durationMs?: number): string {
  const parts: string[] = [];
  if (view?.rowCount !== undefined) {
    parts.push(countOf(view.rowCount, 'row'));
  }
  if (view?.truncated) {
    parts.push(view.limitApplied ? `stopped at the ${view.limitApplied}-row limit` : 'stopped at the limit');
  }
  if (durationMs !== undefined) {
    parts.push(durationMs < 1000 ? `${durationMs} ms` : `${(durationMs / 1000).toFixed(1)} s`);
  }
  return parts.join(' \u00b7 ');
}

/** Everything a tool result shows: error, warnings, export download and table. */
export function ToolResultBody({ output, filename }: { output: unknown; filename?: string }) {
  const view = readToolResult(output);
  return (
    <div className="flex flex-col gap-2">
      {view.error && <ToolErrorBox error={view.error} />}
      {view.warnings.length > 0 && (
        <ul className="rounded-sm border border-border bg-background px-3 py-2 text-sm">
          {view.warnings.map((warning) => (
            <li key={warning}>{warning}</li>
          ))}
        </ul>
      )}
      {view.exportFile && <ExportCard file={view.exportFile} />}
      {view.rows && <ResultTable rows={view.rows} filename={filename} />}
      {!view.rows && !view.error && view.text && (
        <pre className="max-h-80 overflow-auto rounded-sm border border-border bg-card p-3 font-mono text-xs whitespace-pre-wrap">
          {view.text}
        </pre>
      )}
    </div>
  );
}
