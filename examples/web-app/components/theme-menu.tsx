'use client';

import { CheckIcon, MonitorIcon, MoonIcon, SunIcon } from 'lucide-react';
import { useTheme } from 'next-themes';
import { useSyncExternalStore } from 'react';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';

const SYSTEM_THEME = { id: 'system', label: 'System', icon: MonitorIcon };
const THEMES = [SYSTEM_THEME, { id: 'light', label: 'Light', icon: SunIcon }, { id: 'dark', label: 'Dark', icon: MoonIcon }];

const subscribeNothing = () => () => undefined;

/** Icon button with System, Light and Dark; the icon shows the current choice. */
export function ThemeMenu() {
  const { theme, setTheme } = useTheme();
  // The saved theme is only known in the browser
  const hydrated = useSyncExternalStore(subscribeNothing, () => true, () => false);
  const current = (hydrated && THEMES.find((item) => item.id === theme)) || SYSTEM_THEME;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" aria-label={`Theme: ${current.label}`} title={`Theme: ${current.label}`}>
          <current.icon />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-36">
        {THEMES.map((item) => (
          <DropdownMenuItem key={item.id} onSelect={() => setTheme(item.id)}>
            <item.icon />
            {item.label}
            {item.id === current.id && <CheckIcon className="ml-auto" />}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
