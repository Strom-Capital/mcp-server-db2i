'use client';

import type { DynamicToolUIPart } from 'ai';
import { CodeBlock } from '@/components/ai-elements/code-block';
import { Tool, ToolContent, ToolHeader, ToolInput } from '@/components/ai-elements/tool';
import { useDuration } from '@/lib/client/clock';
import { argumentsOf, exportSourceOf, readToolResult, sqlOf } from '@/lib/results';
import { ExportMenu, ExportOutcome, useResultExport } from './export-menu';
import { resultSummary, ToolResultBody } from './tool-result';

/**
 * A tool call in the chat: tool name, status and summary, with the SQL and
 * the result behind a toggle. A result with rows has its Export menu in the
 * header, so it works without opening the card.
 */
export function ToolCard({ part }: { part: DynamicToolUIPart }) {
  const durationMs = useDuration(part.toolCallId);
  const done = part.state === 'output-available';
  const view = done ? readToolResult(part.output) : undefined;
  const failed = part.state === 'output-error' || (view !== undefined && !view.ok);
  const sql = sqlOf(part.input);
  const args = argumentsOf(part.input);
  const summary = part.state === 'output-error' ? 'failed' : resultSummary(view, durationMs);
  const rows = view?.rows?.length ? view.rows : undefined;
  const server = useResultExport(rows ? exportSourceOf(part.toolName, part.input) : undefined);

  return (
    <div className="mb-4 flex flex-col gap-2">
      <Tool className="mb-0 bg-card/60">
        <ToolHeader
          type="dynamic-tool"
          toolName={part.toolName}
          state={failed && done ? 'output-error' : part.state}
          summary={summary}
          actions={rows && <ExportMenu rows={rows} filename={part.toolName} server={server} />}
        />
        <ToolContent className="space-y-3 border-t">
          {sql && <CodeBlock code={sql} language="sql" />}
          {Object.keys(args).length > 0 && <ToolInput input={args} />}
          {part.state === 'output-error' && <p className="text-destructive text-sm">{part.errorText || 'The tool call failed.'}</p>}
          {done && <ToolResultBody output={part.output} tool={part.toolName} input={part.input} showExport={false} />}
        </ToolContent>
      </Tool>
      <ExportOutcome state={server.state} />
    </div>
  );
}
