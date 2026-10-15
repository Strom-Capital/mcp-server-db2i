'use client';

import { useRouter } from 'next/navigation';
import { useMemo, useState, type FormEvent } from 'react';
import type { ToolSummary } from '@/lib/catalog';
import { runTool, SignInNeededError, type ToolRun } from '@/lib/client/run-tool';
import { buildArguments, formFields, type FormField } from '@/lib/schema-form';
import { readToolResult } from '@/lib/results';
import { useAppState } from './app-state';
import { ToolResultBody, resultSummary } from './tool-result';

const INPUT = 'w-full rounded-sm border border-border bg-background px-2 py-1.5 outline-none focus:border-ring';

function FieldInput({ field, value, onChange }: { field: FormField; value: string; onChange: (value: string) => void }) {
  const id = `field-${field.name}`;
  switch (field.kind) {
    case 'boolean':
      return (
        <input
          id={id}
          type="checkbox"
          checked={value === 'true'}
          onChange={(event) => onChange(event.target.checked ? 'true' : '')}
          className="size-4 accent-primary"
        />
      );
    case 'enum':
      return (
        <select id={id} value={value} onChange={(event) => onChange(event.target.value)} className={INPUT}>
          {!field.required && <option value="">Default</option>}
          {field.required && value === '' && <option value="">Choose</option>}
          {field.options?.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      );
    case 'date':
      return <input id={id} type="date" value={value} onChange={(event) => onChange(event.target.value)} className={INPUT} />;
    case 'integer':
    case 'number':
      return (
        <input
          id={id}
          type="text"
          inputMode={field.kind === 'integer' ? 'numeric' : 'decimal'}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          className={`${INPUT} font-mono tabular`}
        />
      );
    case 'json':
      return (
        <textarea
          id={id}
          rows={2}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder='["A", 1]'
          className={`${INPUT} font-mono text-sm`}
        />
      );
    default:
      return field.name === 'sql' ? (
        <textarea
          id={id}
          rows={5}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder="SELECT ORDERNO FROM MYLIB.ORDERS FETCH FIRST 10 ROWS ONLY"
          spellCheck={false}
          className={`${INPUT} font-mono text-sm`}
        />
      ) : (
        <input
          id={id}
          type="text"
          value={value}
          maxLength={field.maxLength}
          onChange={(event) => onChange(event.target.value)}
          className={INPUT}
        />
      );
  }
}

interface RunState {
  loading: boolean;
  run?: ToolRun;
  error?: string;
}

/**
 * A form for one tool's arguments, built from its input schema, with the
 * result below it.
 */
export function ToolForm({ tool }: { tool: ToolSummary }) {
  const fields = useMemo(() => formFields(tool.inputSchema), [tool.inputSchema]);
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries(fields.map((field) => [field.name, field.initial])));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [state, setState] = useState<RunState>({ loading: false });
  const { setDraft, refreshSession } = useAppState();
  const router = useRouter();

  function argumentsOrErrors() {
    const built = buildArguments(fields, values);
    setErrors(built.errors);
    return Object.keys(built.errors).length > 0 ? undefined : built.args;
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    const args = argumentsOrErrors();
    if (!args) {
      return;
    }
    setState({ loading: true });
    try {
      setState({ loading: false, run: await runTool(tool.name, args) });
    } catch (error) {
      if (error instanceof SignInNeededError) {
        refreshSession();
      }
      setState({ loading: false, error: error instanceof Error ? error.message : 'The run failed.' });
    }
  }

  function askInChat() {
    const built = buildArguments(fields, values);
    const given = Object.entries(built.args);
    setDraft(
      given.length > 0
        ? `Use ${tool.name} with ${given.map(([name, value]) => `${name} ${JSON.stringify(value)}`).join(', ')} and summarize the result.`
        : `Use ${tool.name} and summarize the result.`,
    );
    router.push('/');
  }

  const view = state.run ? readToolResult(state.run.output) : undefined;

  return (
    <div className="flex flex-col gap-4">
      <form onSubmit={(event) => void submit(event)} className="flex flex-col gap-3 rounded-sm border border-border bg-card p-4">
        {fields.length === 0 && <p className="text-sm text-muted-foreground">This tool takes no arguments.</p>}
        {fields.map((field) => (
          <div key={field.name} className={field.kind === 'boolean' ? 'flex items-center gap-2' : 'flex flex-col gap-1'}>
            {field.kind === 'boolean' && (
              <FieldInput field={field} value={values[field.name] ?? ''} onChange={(value) => setValues((current) => ({ ...current, [field.name]: value }))} />
            )}
            <label htmlFor={`field-${field.name}`} className="text-sm">
              <span className="font-mono font-medium">{field.name}</span>
              {field.required && <span className="text-destructive"> *</span>}
              {field.description && <span className="text-muted-foreground"> {field.description}</span>}
            </label>
            {field.kind !== 'boolean' && (
              <FieldInput field={field} value={values[field.name] ?? ''} onChange={(value) => setValues((current) => ({ ...current, [field.name]: value }))} />
            )}
            {errors[field.name] && <span className="text-xs text-destructive">{errors[field.name]}</span>}
          </div>
        ))}
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="submit"
            disabled={state.loading}
            className="rounded-sm bg-primary px-4 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          >
            {state.loading ? 'Running' : 'Run'}
          </button>
          <button type="button" onClick={askInChat} className="rounded-sm border border-border px-3 py-1.5 text-sm hover:border-foreground">
            Ask in chat
          </button>
          <span className="flex-1" />
          {state.run && <span className="text-sm text-muted-foreground tabular">{resultSummary(view, state.run.durationMs)}</span>}
        </div>
      </form>
      {state.error && (
        <p role="alert" className="rounded-sm border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {state.error}
        </p>
      )}
      {state.run && <ToolResultBody output={state.run.output} tool={tool.name} input={state.run.input} />}
    </div>
  );
}
