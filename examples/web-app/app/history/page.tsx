'use client';

import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import { useAppState } from '@/components/app-state';
import { ToolResultBody, resultSummary } from '@/components/tool-result';
import { runTool, SignInNeededError } from '@/lib/client/run-tool';
import { clearHistory, useHistory, type HistoryEntry } from '@/lib/client/store';
import { argumentsOf, sqlOf } from '@/lib/results';

interface RunState {
  loading: boolean;
  output?: unknown;
  error?: string;
  durationMs?: number;
}

function describe(entry: HistoryEntry): string {
  return sqlOf(entry.input) ?? JSON.stringify(argumentsOf(entry.input));
}

export default function HistoryPage() {
  const { items, loading } = useHistory();
  const { setDraft, refreshSession } = useAppState();
  const router = useRouter();
  const [query, setQuery] = useState('');
  const [runs, setRuns] = useState<Record<string, RunState>>({});
  const [copied, setCopied] = useState<string>();

  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) {
      return items;
    }
    return items.filter((entry) => `${entry.tool} ${describe(entry)}`.toLowerCase().includes(needle));
  }, [items, query]);

  async function runAgain(entry: HistoryEntry) {
    setRuns((current) => ({ ...current, [entry.id]: { loading: true } }));
    try {
      const run = await runTool(entry.tool, entry.input);
      setRuns((current) => ({ ...current, [entry.id]: { loading: false, output: run.output, durationMs: run.durationMs } }));
    } catch (error) {
      if (error instanceof SignInNeededError) {
        refreshSession();
      }
      setRuns((current) => ({
        ...current,
        [entry.id]: { loading: false, error: error instanceof Error ? error.message : 'The run failed.' },
      }));
    }
  }

  function askAbout(entry: HistoryEntry) {
    const sql = sqlOf(entry.input);
    setDraft(
      sql
        ? `Run this query again and explain what the result shows:\n\n${sql}`
        : `Run ${entry.tool} again with ${JSON.stringify(argumentsOf(entry.input))} and explain the result.`,
    );
    router.push('/');
  }

  return (
    <div className="mx-auto h-full max-w-5xl overflow-y-auto px-4 py-6">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-semibold">Query history</h1>
        <span className="text-sm text-muted-foreground">Kept in this browser. Results are not stored; run a query again to see them.</span>
        <span className="flex-1" />
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search SQL and tools"
          aria-label="Search history"
          className="h-9 w-64 rounded-sm border border-line bg-surface px-2 outline-none focus:border-accent"
        />
        {items.length > 0 && (
          <button
            type="button"
            className="h-9 rounded-sm border border-line px-3 text-sm hover:border-fg"
            onClick={() => {
              if (window.confirm('Delete the whole history in this browser?')) {
                void clearHistory();
              }
            }}
          >
            Clear
          </button>
        )}
      </div>

      {!loading && shown.length === 0 && (
        <p className="mt-10 text-center text-muted-foreground">{items.length === 0 ? 'No queries yet. Ask something in the chat.' : 'Nothing matches.'}</p>
      )}

      <ul className="mt-4 flex flex-col gap-3">
        {shown.map((entry) => {
          const run = runs[entry.id];
          const sql = sqlOf(entry.input);
          return (
            <li key={entry.id} className="rounded-sm border border-line bg-surface/60">
              <div className="flex flex-wrap items-center gap-2 px-3 py-2 text-sm">
                <span className={`inline-block size-2.5 rounded-full ${entry.ok ? 'bg-emerald-600' : 'bg-error'}`} />
                <span className="font-mono font-medium">{entry.tool}</span>
                <span className="text-muted-foreground tabular">
                  {[
                    new Date(entry.at).toLocaleString(),
                    resultSummary({ ok: entry.ok, rowCount: entry.rowCount, truncated: !!entry.truncated, warnings: [] }, entry.durationMs),
                  ]
                    .filter(Boolean)
                    .join(' \u00b7 ')}
                </span>
                <span className="flex-1" />
                <button
                  type="button"
                  className="rounded-sm px-2 py-1 hover:bg-bg"
                  onClick={() => {
                    void navigator.clipboard.writeText(sql ?? JSON.stringify(entry.input, null, 2)).then(() => {
                      setCopied(entry.id);
                      setTimeout(() => setCopied(undefined), 1500);
                    });
                  }}
                >
                  {copied === entry.id ? 'Copied' : sql ? 'Copy SQL' : 'Copy arguments'}
                </button>
                <button type="button" className="rounded-sm px-2 py-1 hover:bg-bg" onClick={() => askAbout(entry)}>
                  Ask about this
                </button>
                <button
                  type="button"
                  disabled={run?.loading}
                  className="rounded-sm border border-line px-2 py-1 hover:border-fg disabled:opacity-50"
                  onClick={() => void runAgain(entry)}
                >
                  {run?.loading ? 'Running' : 'Run again'}
                </button>
              </div>
              <pre className="mx-3 mb-3 max-h-40 overflow-auto rounded-sm bg-bg p-2 font-mono text-xs whitespace-pre-wrap">
                {describe(entry)}
              </pre>
              {entry.error && !run && <p className="mx-3 mb-3 text-sm text-error">{entry.error}</p>}
              {run?.error && <p className="mx-3 mb-3 text-sm text-error">{run.error}</p>}
              {run?.output !== undefined && (
                <div className="border-t border-line px-3 py-3">
                  <ToolResultBody output={run.output} filename={entry.tool} />
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
