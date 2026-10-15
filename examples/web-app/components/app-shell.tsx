'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';
import { PROVIDERS } from '@/lib/providers';
import { useSettings } from '@/lib/client/settings';
import { useAppState } from './app-state';
import { SettingsDialog } from './settings-dialog';

const NAV = [
  { href: '/', label: 'Chat' },
  { href: '/tools', label: 'Tools' },
  { href: '/exports', label: 'Exports' },
  { href: '/context', label: 'Context' },
  { href: '/history', label: 'History' },
];

/** Sign-in status, model button and navigation around every page. */
export function AppShell({ children, nav = NAV }: { children: ReactNode; nav?: { href: string; label: string }[] }) {
  const pathname = usePathname();
  const { session, signOut, setSettingsOpen } = useAppState();
  const settings = useSettings();
  const providerLabel = PROVIDERS.find((item) => item.id === settings.provider)?.label ?? settings.provider;
  const model = settings.models[settings.provider];

  return (
    <div className="flex h-full flex-col">
      <header className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-line px-4 py-2">
        <Link href="/" className="font-semibold">
          db2i<span className="text-accent">-mcp</span>
        </Link>
        <nav className="flex gap-1 text-sm">
          {nav.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              aria-current={pathname === item.href ? 'page' : undefined}
              className={`rounded-sm px-2 py-1 ${pathname === item.href ? 'bg-surface font-medium' : 'text-muted-foreground hover:text-fg'}`}
            >
              {item.label}
            </Link>
          ))}
        </nav>
        <span className="flex-1" />
        <button
          type="button"
          onClick={() => setSettingsOpen(true)}
          className="max-w-64 truncate rounded-sm border border-line px-2 py-1 text-sm hover:border-fg"
          title={model ? `Model settings: ${providerLabel}, ${model}` : 'Model settings'}
        >
          {model ?? 'Choose a model'}
        </button>
        {session.loaded &&
          (session.signedIn ? (
            <div className="flex items-center gap-2 text-sm">
              <span className="text-muted-foreground">Signed in to {session.server}</span>
              <button type="button" onClick={() => void signOut()} className="rounded-sm px-2 py-1 text-muted-foreground hover:text-fg">
                Sign out
              </button>
            </div>
          ) : (
            <a href="/api/auth/signin" className="rounded-sm bg-accent px-3 py-1 text-sm font-medium text-on-accent hover:bg-accent-strong">
              Sign in to IBM i
            </a>
          ))}
      </header>
      {session.signInError && (
        <p role="alert" className="border-b border-line bg-error/10 px-4 py-2 text-sm text-error">
          Sign-in failed: {session.signInError}
        </p>
      )}
      <main className="min-h-0 flex-1">{children}</main>
      <SettingsDialog />
    </div>
  );
}
