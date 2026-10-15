'use client';

import { ChevronDownIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { SidebarInset, SidebarProvider, SidebarTrigger } from '@/components/ui/sidebar';
import { useSettings } from '@/lib/client/settings';
import { PROVIDERS } from '@/lib/providers';
import { AppSidebar } from './app-sidebar';
import { useAppState } from './app-state';
import { SettingsDialog } from './settings-dialog';

/** The sidebar, the model button and the page. */
export function AppShell({ children }: { children: ReactNode }) {
  const { session, setSettingsOpen } = useAppState();
  const settings = useSettings();
  const providerLabel = PROVIDERS.find((item) => item.id === settings.provider)?.label ?? settings.provider;
  const model = settings.models[settings.provider];

  return (
    <SidebarProvider>
      <AppSidebar />
      <SidebarInset className="h-svh min-w-0 overflow-hidden">
        <header className="flex h-12 shrink-0 items-center gap-1 px-2">
          <SidebarTrigger />
          <Button
            variant="ghost"
            className="max-w-72 font-medium"
            onClick={() => setSettingsOpen(true)}
            title={model ? `Model settings: ${providerLabel}, ${model}` : 'Model settings'}
          >
            <span className="truncate">{model ?? 'Choose a model'}</span>
            <ChevronDownIcon className="text-muted-foreground" />
          </Button>
        </header>
        {session.signInError && (
          <p role="alert" className="border-y bg-destructive/10 px-4 py-2 text-destructive text-sm">
            Sign-in failed: {session.signInError}
          </p>
        )}
        <div className="min-h-0 flex-1">{children}</div>
      </SidebarInset>
      <SettingsDialog />
    </SidebarProvider>
  );
}
