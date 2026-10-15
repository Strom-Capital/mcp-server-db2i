import type { Metadata } from 'next';
import { Geist, IBM_Plex_Mono } from 'next/font/google';
import { ThemeProvider } from 'next-themes';
import type { ReactNode } from 'react';
import { AppShell } from '@/components/app-shell';
import { AppStateProvider } from '@/components/app-state';
import { TooltipProvider } from '@/components/ui/tooltip';
import './globals.css';

const geist = Geist({ subsets: ['latin'], variable: '--font-geist' });
const plexMono = IBM_Plex_Mono({ subsets: ['latin'], weight: ['400', '500'], variable: '--font-plex-mono' });

export const metadata: Metadata = {
  title: 'db2i/mcp',
  description: 'Ask questions about IBM i data with your own model key.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${geist.variable} ${plexMono.variable}`} suppressHydrationWarning>
      <body className="antialiased">
        <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
          <TooltipProvider>
            <AppStateProvider>
              <AppShell>{children}</AppShell>
            </AppStateProvider>
          </TooltipProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
