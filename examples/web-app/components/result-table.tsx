'use client';

import {
  columnFilteringFeature,
  columnResizingFeature,
  columnSizingFeature,
  createFilteredRowModel,
  createSortedRowModel,
  filterFn_includesString,
  globalFilteringFeature,
  rowSortingFeature,
  sortFn_basic,
  tableFeatures,
  useTable,
  type ColumnDef,
} from '@tanstack/react-table';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useMemo, useRef, useState } from 'react';
import { compareCells, countOf, formatCell, groupDigits, inferColumns, toCsv, toTsv, type ColumnInfo } from '@/lib/format';
import type { Row } from '@/lib/results';

const features = tableFeatures({
  rowSortingFeature,
  columnFilteringFeature,
  globalFilteringFeature,
  columnSizingFeature,
  columnResizingFeature,
  sortedRowModel: createSortedRowModel(),
  filteredRowModel: createFilteredRowModel(),
  sortFns: { basic: sortFn_basic },
  filterFns: { includesString: filterFn_includesString },
  columnMeta: {} as Pick<ColumnInfo, 'kind' | 'group'>,
});

const ROW_HEIGHT = 32;
const MAX_HEIGHT = 480;

function initialWidth(column: ColumnInfo, rows: Row[]): number {
  const sample = rows.slice(0, 50).map((row) => formatCell(row[column.name], column.kind, column.group).length);
  const longest = Math.max(column.name.length + 3, ...sample);
  return Math.min(Math.max(longest * 8 + 24, 72), 360);
}

function download(filename: string, text: string, type: string): void {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * An interactive table for tool result rows: sort by clicking a header,
 * filter across all columns, resize columns, and copy or download the rows.
 */
export function ResultTable({ rows, filename = 'result' }: { rows: Row[]; filename?: string }) {
  const columnsInfo = useMemo(() => inferColumns(rows), [rows]);
  const [copied, setCopied] = useState(false);

  const columns = useMemo<ColumnDef<typeof features, Row>[]>(
    () =>
      columnsInfo.map((column) => ({
        id: column.name,
        header: column.name,
        accessorFn: (row: Row) => row[column.name],
        size: initialWidth(column, rows),
        minSize: 48,
        meta: { kind: column.kind, group: column.group },
        sortFn: (a, b, columnId) => compareCells(a.getValue(columnId), b.getValue(columnId), column.kind),
        sortUndefined: 'last',
      })),
    [columnsInfo, rows],
  );

  const table = useTable({
    features,
    columns,
    data: rows,
    columnResizeMode: 'onChange',
    globalFilterFn: 'includesString',
  });

  const visibleRows = table.getRowModel().rows;
  const scrollRef = useRef<HTMLDivElement>(null);
  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer({
    count: visibleRows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
  });
  const items = virtualizer.getVirtualItems();
  const padTop = items[0]?.start ?? 0;
  const padBottom = virtualizer.getTotalSize() - (items.at(-1)?.end ?? 0);

  const names = columnsInfo.map((column) => column.name);
  const shownRows = () => visibleRows.map((row) => row.original);

  if (rows.length === 0) {
    return <p className="px-3 py-2 text-sm text-muted-foreground">No rows.</p>;
  }

  const totalWidth = table.getTotalSize();

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <input
          type="search"
          value={(table.state.globalFilter as string | undefined) ?? ''}
          onChange={(event) => table.setGlobalFilter(event.target.value)}
          placeholder="Filter rows"
          aria-label="Filter rows"
          className="h-8 w-48 rounded-sm border border-line bg-surface px-2 outline-none focus:border-accent"
        />
        <span className="text-muted-foreground tabular">
          {visibleRows.length === rows.length ? countOf(rows.length, 'row') : `${groupDigits(String(visibleRows.length))} of ${countOf(rows.length, 'row')}`}
        </span>
        <span className="flex-1" />
        <button
          type="button"
          className="h-8 rounded-sm border border-line px-2 hover:border-fg"
          onClick={() => {
            void navigator.clipboard.writeText(toTsv(names, shownRows())).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            });
          }}
        >
          {copied ? 'Copied' : 'Copy for Excel'}
        </button>
        <button
          type="button"
          className="h-8 rounded-sm border border-line px-2 hover:border-fg"
          onClick={() => download(`${filename}.csv`, `\uFEFF${toCsv(names, shownRows())}`, 'text/csv;charset=utf-8')}
        >
          Download CSV
        </button>
      </div>

      <div ref={scrollRef} className="overflow-auto rounded-sm border border-line bg-surface" style={{ maxHeight: MAX_HEIGHT }}>
        <table className="border-separate border-spacing-0 text-sm" style={{ width: totalWidth, tableLayout: 'fixed' }}>
          <colgroup>
            {table.getFlatHeaders().map((header) => (
              <col key={header.id} style={{ width: header.getSize() }} />
            ))}
          </colgroup>
          <thead className="sticky top-0 z-20">
            {table.getHeaderGroups().map((group) => (
              <tr key={group.id}>
                {group.headers.map((header, index) => {
                  const kind = header.column.columnDef.meta?.kind;
                  const sorted = header.column.getIsSorted();
                  return (
                    <th
                      key={header.id}
                      scope="col"
                      aria-sort={sorted === 'asc' ? 'ascending' : sorted === 'desc' ? 'descending' : 'none'}
                      className={`relative select-none border-b border-line bg-bg px-2 py-1.5 font-medium ${
                        kind === 'number' ? 'text-right' : 'text-left'
                      } ${index === 0 ? 'sticky left-0 z-30 border-r' : ''}`}
                    >
                      <button
                        type="button"
                        className="w-full truncate text-inherit hover:text-accent"
                        style={{ textAlign: 'inherit' }}
                        onClick={header.column.getToggleSortingHandler()}
                        title={`Sort by ${String(header.column.columnDef.header)}`}
                      >
                        {String(header.column.columnDef.header)}
                        {sorted === 'asc' ? ' \u2191' : sorted === 'desc' ? ' \u2193' : ''}
                      </button>
                      <div
                        role="separator"
                        aria-orientation="vertical"
                        aria-label={`Resize ${String(header.column.columnDef.header)}`}
                        onMouseDown={header.getResizeHandler()}
                        onTouchStart={header.getResizeHandler()}
                        onDoubleClick={() => header.column.resetSize()}
                        className="absolute top-0 right-0 h-full w-1.5 cursor-col-resize hover:bg-accent"
                      />
                    </th>
                  );
                })}
              </tr>
            ))}
          </thead>
          <tbody>
            {padTop > 0 && (
              <tr aria-hidden>
                <td style={{ height: padTop }} colSpan={names.length} />
              </tr>
            )}
            {items.map((item) => {
              const row = visibleRows[item.index];
              if (!row) {
                return null;
              }
              return (
                <tr key={row.id} className="group" style={{ height: ROW_HEIGHT }}>
                  {row.getAllCells().map((cell, index) => {
                    const kind = cell.column.columnDef.meta?.kind ?? 'text';
                    const value = cell.getValue();
                    const text = formatCell(value, kind, cell.column.columnDef.meta?.group);
                    return (
                      <td
                        key={cell.id}
                        title={text.length > 30 ? text : undefined}
                        className={`truncate border-b border-line px-2 group-hover:bg-bg ${
                          kind === 'number' ? 'text-right font-mono tabular' : ''
                        } ${index === 0 ? 'sticky left-0 z-10 border-r bg-surface' : ''}`}
                      >
                        {value === null || value === undefined ? <span className="text-muted-foreground">NULL</span> : text}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
            {padBottom > 0 && (
              <tr aria-hidden>
                <td style={{ height: padBottom }} colSpan={names.length} />
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
