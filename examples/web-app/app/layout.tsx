import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { AppShell } from '@/components/app-shell';
import { AppStateProvider } from '@/components/app-state';
import './globals.css';

export const metadata: Metadata = {
  title: 'mcp-server-db2i web app',
  description: 'Ask questions about IBM i data with your own model key.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="h-full antialiased">
        <AppStateProvider>
          <AppShell>{children}</AppShell>
        </AppStateProvider>
      </body>
    </html>
  );
}
