/**
 * The result grid: sortable columns and a filter over every cell. Measures are
 * right-aligned with their digits grouped and their decimals kept; codes such
 * as order numbers stay left-aligned and ungrouped. NULL shows as an empty cell.
 */

import { numberOf, type Column, type ResultTable, type Row } from './data.js';

/** Rows drawn at once. Results are capped by the row limit, but that can be high. */
const MAX_RENDERED_ROWS = 1000;

const NUMERIC = new Set(['int', 'bigint', 'decimal', 'float']);

interface GridState {
  sortBy?: string;
  descending: boolean;
  filter: string;
}

/** A measure's value with its digits grouped, keeping every decimal it came with. */
function measureText(value: unknown, format: (decimals: number) => Intl.NumberFormat): string {
  const text = cellText(value).trim();
  const match = /^-?\d+(?:\.(\d+))?$/.exec(text);
  if (!match) {
    return text;
  }
  // Format the string, not a Number, so DECIMAL values longer than a double keep their digits
  return format(match[1]?.length ?? 0).format(text as unknown as number);
}

function cellText(value: unknown): string {
  if (value === null || value === undefined) {
    return '';
  }
  return typeof value === 'object' ? JSON.stringify(value) : String(value);
}

function compare(a: unknown, b: unknown, column: Column): number {
  if (a === null || a === undefined) return b === null || b === undefined ? 0 : 1;
  if (b === null || b === undefined) return -1;
  if (NUMERIC.has(column.kind)) {
    return (numberOf(a) ?? 0) - (numberOf(b) ?? 0);
  }
  return cellText(a).localeCompare(cellText(b), undefined, { numeric: true });
}

/**
 * Render the grid into a container.
 *
 * @param container - Element to fill
 * @param table - The result
 * @param bar - Toolbar that takes the row count and the filter, so they share a line with its other controls
 */
export function renderGrid(
  container: HTMLElement,
  table: ResultTable,
  bar: HTMLElement,
  options: { locale?: string } = {},
): void {
  const state: GridState = { descending: false, filter: '' };
  const formats = new Map<number, Intl.NumberFormat>();
  const format = (decimals: number): Intl.NumberFormat => {
    let found = formats.get(decimals);
    if (!found) {
      found = new Intl.NumberFormat(options.locale, { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
      formats.set(decimals, found);
    }
    return found;
  };
  // Right-align and group only real quantities; numeric codes and dates read as text
  const isMeasure = (column: Column): boolean => column.role === 'measure' && NUMERIC.has(column.kind);
  const shownText = (value: unknown, column: Column): string =>
    isMeasure(column) ? measureText(value, format) : cellText(value);
  container.replaceChildren();

  const toolbar = document.createElement('div');
  toolbar.className = 'grid-toolbar';
  const filter = document.createElement('input');
  filter.type = 'search';
  filter.placeholder = 'Filter rows';
  filter.setAttribute('aria-label', 'Filter rows');
  filter.dataset.focus = 'filter';
  const count = document.createElement('span');
  count.className = 'meta';
  count.setAttribute('aria-live', 'polite');
  toolbar.append(count, filter);
  bar.append(toolbar);

  const scroller = document.createElement('div');
  scroller.className = 'grid-scroll';
  const tableEl = document.createElement('table');
  const thead = document.createElement('thead');
  const tbody = document.createElement('tbody');
  tableEl.append(thead, tbody);
  scroller.append(tableEl);
  container.append(scroller);

  const headRow = document.createElement('tr');
  for (const column of table.columns) {
    const th = document.createElement('th');
    th.scope = 'col';
    th.setAttribute('aria-sort', 'none');
    if (isMeasure(column)) th.className = 'num';
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.focus = `sort-${column.name}`;
    button.textContent = column.name;
    button.title = `Sort by ${column.name} (${column.kind})`;
    // Ascending, then descending, then back to the order the query returned
    button.addEventListener('click', () => {
      if (state.sortBy !== column.name) {
        state.sortBy = column.name;
        state.descending = false;
      } else if (!state.descending) {
        state.descending = true;
      } else {
        state.sortBy = undefined;
        state.descending = false;
      }
      draw();
    });
    th.append(button);
    headRow.append(th);
  }
  thead.append(headRow);

  filter.addEventListener('input', () => {
    state.filter = filter.value.trim().toLowerCase();
    draw();
  });

  function visibleRows(): Row[] {
    let rows = table.rows;
    if (state.filter) {
      // Match what the cell shows and the raw value, so "1 250" and "1250" both find it
      rows = rows.filter((row) => table.columns.some((c) => {
        const value = row[c.name];
        return cellText(value).toLowerCase().includes(state.filter)
          || (isMeasure(c) && shownText(value, c).toLowerCase().includes(state.filter));
      }));
    }
    const sortColumn = table.columns.find((c) => c.name === state.sortBy);
    if (sortColumn) {
      const sign = state.descending ? -1 : 1;
      rows = [...rows].sort((a, b) => sign * compare(a[sortColumn.name], b[sortColumn.name], sortColumn));
    }
    return rows;
  }

  function draw(): void {
    const rows = visibleRows();
    const shown = rows.slice(0, MAX_RENDERED_ROWS);
    const fragment = document.createDocumentFragment();
    for (const row of shown) {
      const tr = document.createElement('tr');
      for (const column of table.columns) {
        const td = document.createElement('td');
        const value = row[column.name];
        if (isMeasure(column)) td.className = 'num';
        if (value === null || value === undefined) {
          td.classList.add('null');
          td.title = 'No value (NULL)';
          const hidden = document.createElement('span');
          hidden.className = 'sr-only';
          hidden.textContent = 'No value';
          td.append(hidden);
        } else {
          td.textContent = shownText(value, column);
        }
        tr.append(td);
      }
      fragment.append(tr);
    }
    tbody.replaceChildren(fragment);
    for (const th of headRow.children) {
      const name = (th.firstChild as HTMLButtonElement).textContent;
      th.setAttribute('aria-sort', name === state.sortBy ? (state.descending ? 'descending' : 'ascending') : 'none');
    }
    const total = table.rows.length;
    const parts = [rows.length === total ? `${total} rows` : `${rows.length} of ${total} rows`];
    if (shown.length < rows.length) parts.push(`showing the first ${shown.length}`);
    if (table.truncated) parts.push('more rows matched');
    count.textContent = parts.join(' \u00b7 ');
  }

  draw();
}
