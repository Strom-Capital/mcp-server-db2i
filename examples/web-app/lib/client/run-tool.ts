'use client';

import { readToolResult, sqlOf } from '../results';
import { addExport, addHistory } from './store';

/** What one direct tool run returned. */
export interface ToolRun {
  output: unknown;
  durationMs?: number;
}

/** The server refused the run because the browser must sign in again. */
export class SignInNeededError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SignInNeededError';
  }
}

/**
 * Run one tool without a model, and record it in the history, and in the
 * exports list when it wrote a file.
 *
 * @param name - Tool name
 * @param args - Tool arguments
 * @returns The tool result and how long it took
 * @throws SignInNeededError when the session has ended, Error when the run failed
 */
export async function runTool(name: string, args: Record<string, unknown>): Promise<ToolRun> {
  const response = await fetch('/api/tools/run', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, arguments: args }),
  });
  const body = (await response.json().catch(() => ({}))) as { result?: unknown; error?: string; durationMs?: number; signIn?: boolean };
  if (!response.ok) {
    const message = body.error ?? 'The run failed.';
    throw body.signIn ? new SignInNeededError(message) : new Error(message);
  }
  const view = readToolResult(body.result);
  const at = Date.now();
  void addHistory({
    id: crypto.randomUUID(),
    at,
    tool: name,
    input: args,
    ok: view.ok,
    rowCount: view.rowCount,
    truncated: view.truncated,
    durationMs: body.durationMs,
    error: view.error?.message,
    source: 'direct',
  });
  if (view.exportFile) {
    void addExport({ ...view.exportFile, at, tool: name, sql: sqlOf(args), input: args });
  }
  return { output: body.result, durationMs: body.durationMs };
}
