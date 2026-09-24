import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/db/connection.js', () => ({
  executeQuery: vi.fn(),
  executeProcedure: vi.fn(),
  initializePool: vi.fn(),
  closeGlobalPool: vi.fn(),
}));

import { loadCustomTools } from '../../src/customTools/loader.js';
import { getCustomTools, resetCustomTools, setCustomTools } from '../../src/customTools/registry.js';
import { reloadCustomTools, startCustomToolsWatch, stopCustomToolsWatch } from '../../src/customTools/watch.js';
import { createServer, liveCustomTool, pinStdioServer } from '../../src/server.js';
import { logger } from '../../src/utils/logger.js';

const dirs: string[] = [];
const releases: Array<() => void> = [];

afterEach(() => {
  stopCustomToolsWatch();
  for (const release of releases) {
    release();
  }
  releases.length = 0;
  resetCustomTools();
  for (const dir of dirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  dirs.length = 0;
  delete process.env.MCP_CUSTOM_TOOLS;
  delete process.env.QUERY_ALLOWED_SCHEMAS;
  delete process.env.MCP_TOOLS_ENABLED;
  delete process.env.MCP_TOOLS_DISABLED;
});

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'db2i-watch-'));
  dirs.push(dir);
  return dir;
}

function toolYaml(name: string, description: string, sql = 'SELECT ORDERNO FROM MYLIB.ORDERHDR'): string {
  return `
version: 1
tools:
  - name: ${name}
    title: ${description}
    description: ${description}
    sql: ${sql}
`;
}

async function waitFor(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    if (check()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('timed out waiting for custom tools reload');
}

describe('reloadCustomTools', () => {
  it('keeps the last good set when the new file is invalid', () => {
    const dir = tempDir();
    const file = path.join(dir, 'tools.yaml');
    writeFileSync(file, toolYaml('search_sales_orders', 'Open sales orders'));
    process.env.MCP_CUSTOM_TOOLS = dir;
    expect(reloadCustomTools()).toBe(true);
    expect(getCustomTools().tools[0]?.sql).toContain('SELECT ORDERNO');

    const error = vi.spyOn(logger, 'error').mockImplementation(() => {});
    writeFileSync(file, toolYaml('search_sales_orders', 'Open sales orders', 'DELETE FROM MYLIB.ORDERHDR'));
    expect(reloadCustomTools()).toBe(false);
    expect(getCustomTools().tools[0]?.sql).toContain('SELECT ORDERNO');
    expect(error).toHaveBeenCalled();
    expect(String(error.mock.calls[0]?.[1])).toMatch(/keeping the last good set/);
    error.mockRestore();
  });
});

describe('custom tools watch', () => {
  it('reloads a valid edit and a file added or removed in the directory', async () => {
    const dir = tempDir();
    const orders = path.join(dir, 'orders.yaml');
    writeFileSync(orders, toolYaml('search_sales_orders', 'Open sales orders'));
    process.env.MCP_CUSTOM_TOOLS = dir;
    setCustomTools(loadCustomTools([dir]));

    const server = createServer();
    releases.push(pinStdioServer(server));
    const listChanged = vi.spyOn(server, 'sendToolListChanged');
    startCustomToolsWatch({ debounceMs: 30 });

    writeFileSync(orders, toolYaml('search_sales_orders', 'Closed sales orders'));
    await waitFor(() => liveCustomTool(server, 'search_sales_orders')?.description === 'Closed sales orders');
    expect(listChanged).toHaveBeenCalled();
    expect(getCustomTools().tools[0]?.description).toBe('Closed sales orders');

    writeFileSync(path.join(dir, 'customers.yaml'), toolYaml('get_customer', 'One customer'));
    await waitFor(() => getCustomTools().tools.some((tool) => tool.name === 'get_customer'));
    expect(liveCustomTool(server, 'get_customer')?.description).toBe('One customer');

    unlinkSync(orders);
    await waitFor(() => !getCustomTools().tools.some((tool) => tool.name === 'search_sales_orders'));
    expect(liveCustomTool(server, 'search_sales_orders')).toBeUndefined();
    expect(getCustomTools().tools.map((tool) => tool.name)).toEqual(['get_customer']);
  });
});
