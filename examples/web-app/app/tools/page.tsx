'use client';

import { useMemo, useState } from 'react';
import { useAppState } from '@/components/app-state';
import { ToolForm } from '@/components/tool-form';
import { groupTools, type ToolSummary } from '@/lib/catalog';
import { loadCatalog, useCatalog } from '@/lib/client/catalog';

function matches(tool: ToolSummary, needle: string): boolean {
  return !needle || `${tool.name} ${tool.title ?? ''} ${tool.description ?? ''} ${tool.toolset ?? ''}`.toLowerCase().includes(needle);
}

/** Every tool the server offers this user: business SQL tools by toolset, then the built-in tools, each with a form. */
export default function ToolsPage() {
  const { session } = useAppState();
  const catalog = useCatalog(session.signedIn);
  const [query, setQuery] = useState('');
  const [picked, setPicked] = useState<string>();

  const groups = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return groupTools(catalog.tools.filter((tool) => matches(tool, needle)));
  }, [catalog.tools, query]);
  const selected =
    catalog.tools.find((tool) => tool.name === picked) ??
    catalog.tools.find((tool) => tool.kind === 'business') ??
    catalog.tools[0];
  const businessCount = catalog.tools.filter((tool) => tool.kind === 'business').length;

  if (session.loaded && !session.signedIn) {
    return (
      <div className="mx-auto max-w-xl px-4 py-16 text-center">
        <h1 className="text-xl font-semibold">Tools</h1>
        <p className="mt-2 text-muted-foreground">Sign in to the IBM i to see the tools you can run.</p>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col md:flex-row">
      <aside className="flex max-h-72 shrink-0 flex-col border-b border-border md:max-h-none md:w-80 md:border-r md:border-b-0">
        <div className="flex flex-col gap-2 p-3">
          <div className="flex items-baseline justify-between">
            <h1 className="font-semibold">Tools</h1>
            {catalog.status === 'ready' && (
              <span className="text-xs text-muted-foreground tabular">
                {businessCount} business, {catalog.tools.length - businessCount} built-in
              </span>
            )}
          </div>
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search tools"
            aria-label="Search tools"
            className="h-9 rounded-sm border border-border bg-card px-2 text-sm outline-none focus:border-ring"
          />
        </div>
        <nav className="min-h-0 flex-1 overflow-y-auto px-2 pb-3" aria-label="Tools">
          {catalog.status === 'loading' && <p className="px-2 text-sm text-muted-foreground">Loading tools...</p>}
          {catalog.status === 'error' && (
            <div className="px-2 text-sm">
              <p className="text-destructive">{catalog.error}</p>
              <button type="button" onClick={() => void loadCatalog(true)} className="mt-2 rounded-sm border border-border px-2 py-1 hover:border-foreground">
                Try again
              </button>
            </div>
          )}
          {catalog.status === 'ready' && groups.length === 0 && <p className="px-2 text-sm text-muted-foreground">No tools match.</p>}
          {groups.map((group) => (
            <section key={group.id} className="mt-2">
              <h2 className="px-2 py-1 text-xs font-medium tracking-wide text-muted-foreground uppercase">{group.label}</h2>
              <ul>
                {group.tools.map((tool) => (
                  <li key={tool.name}>
                    <button
                      type="button"
                      onClick={() => setPicked(tool.name)}
                      aria-current={selected?.name === tool.name ? 'true' : undefined}
                      className={`flex w-full flex-col rounded-sm px-2 py-1.5 text-left ${
                        selected?.name === tool.name ? 'bg-card' : 'hover:bg-card/60'
                      }`}
                    >
                      <span className="truncate text-sm">{tool.title ?? tool.name}</span>
                      <span className="truncate font-mono text-xs text-muted-foreground">{tool.name}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </nav>
      </aside>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {selected ? (
          <div className="mx-auto flex max-w-4xl flex-col gap-4 px-4 py-6">
            <div>
              <div className="flex flex-wrap items-baseline gap-x-3">
                <h2 className="text-xl font-semibold">{selected.title ?? selected.name}</h2>
                <code className="text-sm text-muted-foreground">{selected.name}</code>
                <span className="rounded-sm border border-border px-1.5 text-xs text-muted-foreground">
                  {selected.kind === 'business' ? `Business${selected.toolset ? `: ${selected.toolset}` : ''}` : 'Built-in'}
                </span>
              </div>
              {selected.description && <p className="mt-2 text-sm whitespace-pre-line">{selected.description}</p>}
            </div>
            <ToolForm key={selected.name} tool={selected} />
          </div>
        ) : (
          catalog.status === 'ready' && <p className="mt-16 text-center text-muted-foreground">The server offers no tools to this user.</p>
        )}
      </div>
    </div>
  );
}
