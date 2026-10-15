'use client';

import { ChevronDownIcon, DownloadIcon, FileSpreadsheetIcon, FileTextIcon } from 'lucide-react';
import { useState } from 'react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Spinner } from '@/components/ui/spinner';
import { useCatalog } from '@/lib/client/catalog';
import { runTool } from '@/lib/client/run-tool';
import { countOf, inferColumns, toCsv } from '@/lib/format';
import { readToolResult, type ExportSource, type Row } from '@/lib/results';
import { useAppState } from './app-state';
import { ExportCard, ToolErrorBox } from './result-parts';

export type ExportState =
  | { status: 'idle' }
  | { status: 'running' }
  | { status: 'done'; output: unknown }
  | { status: 'failed'; message: string };

/**
 * Server export of a result through export_query, when the server lists that
 * tool and the result came from a query it can run again.
 *
 * @param source - The query behind the result
 * @returns Whether a server export is possible, its state, and a function that starts one
 */
export function useResultExport(source: ExportSource | undefined) {
  const { session } = useAppState();
  const catalog = useCatalog(session.signedIn);
  const [state, setState] = useState<ExportState>({ status: 'idle' });
  const available = !!source && catalog.tools.some((tool) => tool.name === 'export_query');

  async function start(format: 'xlsx' | 'csv') {
    if (!source) {
      return;
    }
    setState({ status: 'running' });
    try {
      const run = await runTool('export_query', { ...source, format });
      setState({ status: 'done', output: run.output });
    } catch (error) {
      setState({ status: 'failed', message: error instanceof Error ? error.message : 'The export failed.' });
    }
  }

  return { available, state, start };
}

function download(filename: string, text: string, type: string): void {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

interface ExportMenuProps {
  /** Rows the browser CSV holds. */
  rows: Row[];
  filename: string;
  /** Wording for the browser CSV, such as "shown" when a filter is on. */
  rowsLabel?: string;
  server: ReturnType<typeof useResultExport>;
}

/** Export button: every row as Excel or CSV from the server, or the rows as CSV from the browser when the server can't export them. */
export function ExportMenu({ rows, filename, rowsLabel, server }: ExportMenuProps) {
  const running = server.state.status === 'running';
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          disabled={running}
          className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-sm border border-border bg-card px-2 text-sm hover:border-foreground disabled:opacity-60"
        >
          {running ? <Spinner /> : <DownloadIcon className="size-4" />}
          {running ? 'Exporting' : 'Export'}
          <ChevronDownIcon className="size-4 text-muted-foreground" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        {server.available ? (
          <>
            <DropdownMenuLabel className="font-normal text-muted-foreground text-xs">Every row, from the server</DropdownMenuLabel>
            <DropdownMenuItem onSelect={() => void server.start('xlsx')}>
              <FileSpreadsheetIcon />
              Excel (.xlsx)
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => void server.start('csv')}>
              <FileTextIcon />
              CSV
            </DropdownMenuItem>
          </>
        ) : (
          <DropdownMenuItem
            onSelect={() => {
              const names = inferColumns(rows).map((column) => column.name);
              download(`${filename}.csv`, `\uFEFF${toCsv(names, rows)}`, 'text/csv;charset=utf-8');
            }}
          >
            <FileTextIcon />
            CSV of {rowsLabel ? `the ${countOf(rows.length, 'row')} ${rowsLabel}` : countOf(rows.length, 'row')}
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The file a server export wrote, or why it failed. */
export function ExportOutcome({ state }: { state: ExportState }) {
  if (state.status === 'failed') {
    return (
      <p role="alert" className="rounded-sm border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
        {state.message}
      </p>
    );
  }
  if (state.status !== 'done') {
    return null;
  }
  const view = readToolResult(state.output);
  if (view.exportFile) {
    return <ExportCard file={view.exportFile} />;
  }
  if (view.error) {
    return <ToolErrorBox error={view.error} />;
  }
  return <p className="text-muted-foreground text-sm">{view.text ?? 'The export returned no file.'}</p>;
}
