'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { useAppState } from '@/components/app-state';
import { annotationMatches, type Annotation, type BusinessContext } from '@/lib/context';

interface LoadState {
  status: 'loading' | 'ready' | 'error';
  context?: BusinessContext;
  error?: string;
}

function joinText(join: Record<string, string>): string {
  return Object.entries(join)
    .map(([from, to]) => `${from} = ${to}`)
    .join(' AND ');
}

function AnnotationCard({ annotation, onAsk }: { annotation: Annotation; onAsk: () => void }) {
  const columns = Object.entries(annotation.columns ?? {});
  return (
    <li className="rounded-sm border border-border bg-card/60">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2">
        <code className="font-medium">{annotation.table}</code>
        {annotation.entity && <span className="rounded-sm border border-border px-1.5 text-xs text-muted-foreground">{annotation.entity}</span>}
        <span className="flex-1" />
        <button type="button" onClick={onAsk} className="rounded-sm px-2 py-1 text-sm hover:bg-background">
          Ask about this table
        </button>
      </div>
      <div className="flex flex-col gap-3 px-3 pb-3 text-sm">
        {annotation.description && <p>{annotation.description}</p>}
        {annotation.filters && annotation.filters.length > 0 && (
          <div className="rounded-sm border border-primary/40 bg-primary/5 px-3 py-2">
            <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">Most queries need</p>
            <ul className="mt-1 flex flex-col gap-1">
              {annotation.filters.map((filter) => (
                <li key={filter.sql}>
                  <code className="font-mono text-xs">{filter.sql}</code>
                  {filter.reason && <span className="text-muted-foreground"> {filter.reason}</span>}
                </li>
              ))}
            </ul>
          </div>
        )}
        {columns.length > 0 && (
          <table className="w-full border-collapse text-left">
            <thead>
              <tr className="text-xs text-muted-foreground">
                <th className="w-48 border-b border-border py-1 pr-3 font-medium">Column</th>
                <th className="border-b border-border py-1 font-medium">Meaning</th>
              </tr>
            </thead>
            <tbody>
              {columns.map(([name, note]) => (
                <tr key={name}>
                  <td className="border-b border-border py-1 pr-3 align-top font-mono text-xs">{name}</td>
                  <td className="border-b border-border py-1">{note}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {annotation.relations?.length > 0 && (
          <div>
            <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">Joins</p>
            <ul className="mt-1 flex flex-col gap-1">
              {annotation.relations.map((relation) => (
                <li key={`${relation.table}:${joinText(relation.join)}`}>
                  <code className="font-mono text-xs">{relation.table}</code>
                  <span className="text-muted-foreground"> on </span>
                  <code className="font-mono text-xs">{joinText(relation.join)}</code>
                  {relation.cardinality && <span className="text-muted-foreground"> ({relation.cardinality})</span>}
                  {relation.description && <span> {relation.description}</span>}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </li>
  );
}

/** The tables, column notes, row filters and joins the server's YAML files describe. */
export default function ContextPage() {
  const { session, setDraft, refreshSession } = useAppState();
  const router = useRouter();
  const [state, setState] = useState<LoadState>({ status: 'loading' });
  const [query, setQuery] = useState('');

  useEffect(() => {
    if (!session.signedIn) {
      return;
    }
    let cancelled = false;
    fetch('/api/context', { cache: 'no-store' })
      .then(async (response) => {
        const body = (await response.json()) as BusinessContext & { error?: string; signIn?: boolean };
        if (cancelled) {
          return;
        }
        if (!response.ok) {
          if (body.signIn) {
            refreshSession();
          }
          setState({ status: 'error', error: body.error ?? 'Could not load the business context.' });
          return;
        }
        setState({ status: 'ready', context: body });
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setState({ status: 'error', error: error instanceof Error ? error.message : 'Could not load the business context.' });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [session.signedIn, refreshSession]);

  const annotations = state.context?.annotations;
  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return (annotations ?? []).filter((annotation) => annotationMatches(annotation, needle));
  }, [annotations, query]);

  function ask(annotation: Annotation) {
    setDraft(`Describe ${annotation.table}${annotation.entity ? ` (${annotation.entity})` : ''} and show 10 example rows.`);
    router.push('/');
  }

  if (session.loaded && !session.signedIn) {
    return (
      <div className="mx-auto max-w-xl px-4 py-16 text-center">
        <h1 className="text-xl font-semibold">Business context</h1>
        <p className="mt-2 text-muted-foreground">Sign in to the IBM i to see what your tables mean.</p>
      </div>
    );
  }

  return (
    <div className="mx-auto h-full max-w-5xl overflow-y-auto px-4 py-6">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-semibold">Business context</h1>
        <span className="text-sm text-muted-foreground">What the tables mean, as your team wrote it down. The model reads the same notes.</span>
        <span className="flex-1" />
        {annotations && annotations.length > 0 && (
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search tables, entities and columns"
            aria-label="Search business context"
            className="h-9 w-72 rounded-sm border border-border bg-card px-2 outline-none focus:border-ring"
          />
        )}
      </div>

      {state.status === 'loading' && <p className="mt-10 text-center text-muted-foreground">Loading...</p>}
      {state.status === 'error' && <p className="mt-10 text-center text-destructive">{state.error}</p>}
      {state.status === 'ready' && !state.context?.available && (
        <p className="mt-10 text-center text-muted-foreground">The server does not offer business context to this user.</p>
      )}
      {state.status === 'ready' && state.context?.available && annotations?.length === 0 && (
        <p className="mx-auto mt-10 max-w-xl text-center text-muted-foreground">
          No business context is loaded. Add table annotations to the YAML files in MCP_CUSTOM_TOOLS to describe tables, columns and joins.
        </p>
      )}
      {annotations && annotations.length > 0 && shown.length === 0 && <p className="mt-10 text-center text-muted-foreground">Nothing matches.</p>}

      <ul className="mt-4 flex flex-col gap-3">
        {shown.map((annotation) => (
          <AnnotationCard key={annotation.table} annotation={annotation} onAsk={() => ask(annotation)} />
        ))}
      </ul>
    </div>
  );
}
