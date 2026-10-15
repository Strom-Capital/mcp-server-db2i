/**
 * The result grid: sortable columns, a filter over every cell, and numbers
 * right-aligned. Values are shown as the tool returned them.
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
 */
export function renderGrid(container: HTMLElement, table: ResultTable): void {
  const state: GridState = { descending: false, filter: '' };
  container.replaceChildren();

  const toolbar = document.createElement('div');
  toolbar.className = 'grid-toolbar';
  const filter = document.createElement('input');
  filter.type = 'search';
  filter.placeholder = 'Filter rows';
  filter.setAttribute('aria-label', 'Filter rows');
  const count = document.createElement('span');
  count.className = 'meta';
  toolbar.append(filter, count);

  const scroller = document.createElement('div');
  scroller.className = 'grid-scroll';
  const tableEl = document.createElement('table');
  const thead = document.createElement('thead');
  const tbody = document.createElement('tbody');
  tableEl.append(thead, tbody);
  scroller.append(tableEl);
  container.append(toolbar, scroller);

  const headRow = document.createElement('tr');
  for (const column of table.columns) {
    const th = document.createElement('th');
    th.scope = 'col';
    if (NUMERIC.has(column.kind)) th.className = 'num';
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = column.name;
    button.title = `${column.name} (${column.kind})`;
    button.addEventListener('click', () => {
      state.descending = state.sortBy === column.name ? !state.descending : false;
      state.sortBy = column.name;
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
      rows = rows.filter((row) => table.columns.some((c) => cellText(row[c.name]).toLowerCase().includes(state.filter)));
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
        if (NUMERIC.has(column.kind)) td.className = 'num';
        if (value === null || value === undefined) {
          td.classList.add('null');
          td.textContent = 'NULL';
        } else {
          td.textContent = cellText(value);
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
