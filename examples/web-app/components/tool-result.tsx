'use client';

import { countOf } from '@/lib/format';
import { exportSourceOf, readToolResult, type ToolResultView } from '@/lib/results';
import { ExportCard, ToolErrorBox } from './result-parts';
import { ResultTable } from './result-table';

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
export function ToolResultBody({
  output,
  tool,
  input,
  showExport = true,
}: {
  output: unknown;
  tool?: string;
  input?: unknown;
  /** Show the table's Export menu. Off when the tool card header has it. */
  showExport?: boolean;
}) {
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
      {view.rows && (
        <ResultTable rows={view.rows} filename={tool} truncated={view.truncated} exportSource={exportSourceOf(tool, input)} showExport={showExport} />
      )}
      {!view.rows && !view.error && view.text && (
        <pre className="max-h-80 overflow-auto rounded-sm border border-border bg-card p-3 font-mono text-xs whitespace-pre-wrap">
          {view.text}
        </pre>
      )}
    </div>
  );
}
