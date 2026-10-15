'use client';

import { useState } from 'react';
import { useDuration } from '@/lib/client/clock';
import { argumentsOf, readToolResult, sqlOf } from '@/lib/results';
import { resultSummary, ToolResultBody } from './tool-result';

type State = 'input-streaming' | 'input-available' | 'approval-requested' | 'approval-responded' | 'output-available' | 'output-error' | 'output-denied';

interface ToolCardProps {
  toolCallId: string;
  toolName: string;
  state: State;
  input: unknown;
  output?: unknown;
  errorText?: string;
}

function StatusDot({ state, ok }: { state: State; ok: boolean }) {
  if (state === 'input-streaming' || state === 'input-available') {
    return <span className="inline-block size-2.5 animate-pulse rounded-full bg-accent" aria-label="Running" />;
  }
  return <span className={`inline-block size-2.5 rounded-full ${ok ? 'bg-emerald-600' : 'bg-error'}`} aria-label={ok ? 'Done' : 'Failed'} />;
}

/**
 * A tool call in the chat: tool name, status and summary, with the SQL and
 * the result behind a toggle. Results with rows start open.
 */
export function ToolCard({ toolCallId, toolName, state, input, output, errorText }: ToolCardProps) {
  const durationMs = useDuration(toolCallId);
  const done = state === 'output-available';
  const view = done ? readToolResult(output) : undefined;
  const ok = done ? view?.ok ?? true : false;
  const [open, setOpen] = useState<boolean | undefined>(undefined);
  const expanded = open ?? (!!view?.rows?.length || !!view?.exportFile || !ok);

  const sql = sqlOf(input);
  const args = argumentsOf(input);
  const summary = state === 'output-error' ? 'failed' : resultSummary(view, durationMs);

  return (
    <div className="my-2 rounded-sm border border-line bg-surface/60">
      <button
        type="button"
        onClick={() => setOpen(!expanded)}
        aria-expanded={expanded}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm"
      >
        <StatusDot state={state} ok={ok && state !== 'output-error'} />
        <span className="font-mono font-medium">{toolName}</span>
        <span className="truncate text-muted-foreground tabular">{summary}</span>
        <span className="flex-1" />
        <span className="text-muted-foreground">{expanded ? 'Hide' : 'Show'}</span>
      </button>
      {expanded && (
        <div className="flex flex-col gap-2 border-t border-line px-3 py-3">
          {sql && (
            <pre className="overflow-x-auto rounded-sm bg-bg p-3 font-mono text-xs whitespace-pre-wrap">{sql}</pre>
          )}
          {Object.keys(args).length > 0 && (
            <pre className="overflow-x-auto rounded-sm bg-bg p-3 font-mono text-xs">{JSON.stringify(args, null, 2)}</pre>
          )}
          {state === 'output-error' && <p className="text-sm text-error">{errorText ?? 'The tool call failed.'}</p>}
          {done && <ToolResultBody output={output} filename={toolName} />}
        </div>
      )}
    </div>
  );
}
