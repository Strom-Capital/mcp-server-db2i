'use client';

import {
  BookOpenIcon,
  CheckIcon,
  DownloadIcon,
  LogInIcon,
  LogOutIcon,
  MonitorIcon,
  MoonIcon,
  MoreHorizontalIcon,
  ServerIcon,
  SquarePenIcon,
  SunIcon,
  Trash2Icon,
  WrenchIcon,
} from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useTheme } from 'next-themes';
import { useMemo, useState, useSyncExternalStore } from 'react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInput,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
  useSidebar,
} from '@/components/ui/sidebar';
import { chatMatches, groupChats } from '@/lib/chats';
import { useNow } from '@/lib/client/clock';
import { deleteChat, useChats } from '@/lib/client/store';
import { useAppState } from './app-state';
import { Logo } from './logo';

const PAGES = [
  { href: '/tools', label: 'Tools', icon: WrenchIcon },
  { href: '/exports', label: 'Exports', icon: DownloadIcon },
  { href: '/context', label: 'Context', icon: BookOpenIcon },
];

const SYSTEM_THEME = { id: 'system', label: 'System', icon: MonitorIcon };
const THEMES = [
  SYSTEM_THEME,
  { id: 'light', label: 'Light', icon: SunIcon },
  { id: 'dark', label: 'Dark', icon: MoonIcon },
];

const subscribeNothing = () => () => undefined;

/** New chat, the other pages, saved chats with search, theme and sign-in. */
export function AppSidebar() {
  const pathname = usePathname();
  const router = useRouter();
  const { session, signOut, dropChat } = useAppState();
  const { setOpenMobile } = useSidebar();
  const { theme, setTheme } = useTheme();
  const { items: chats } = useChats();
  const [search, setSearch] = useState('');
  const now = useNow();
  const groups = useMemo(() => groupChats(chats.filter((chat) => chatMatches(chat, search)), now), [chats, search, now]);
  const close = () => setOpenMobile(false);
  // The saved theme is only known in the browser
  const hydrated = useSyncExternalStore(subscribeNothing, () => true, () => false);
  const currentTheme = (hydrated && THEMES.find((item) => item.id === theme)) || SYSTEM_THEME;

  async function remove(id: string) {
    dropChat(id);
    await deleteChat(id);
    if (pathname === `/c/${id}`) {
      router.push('/');
    }
  }

  return (
    <Sidebar>
      <SidebarHeader className="gap-3 px-3 pt-4">
        <Link href="/" onClick={close} className="px-1" aria-label="db2i/mcp, new chat">
          <Logo className="h-5" />
        </Link>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton asChild isActive={pathname === '/'}>
              <Link href="/" onClick={close}>
                <SquarePenIcon />
                New chat
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
          {PAGES.map((page) => (
            <SidebarMenuItem key={page.href}>
              <SidebarMenuButton asChild isActive={pathname === page.href}>
                <Link href={page.href} onClick={close}>
                  <page.icon />
                  {page.label}
                </Link>
              </SidebarMenuButton>
            </SidebarMenuItem>
          ))}
        </SidebarMenu>
        <SidebarInput
          type="search"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search chats and SQL"
          aria-label="Search chats"
        />
      </SidebarHeader>

      <SidebarContent>
        {groups.length === 0 && (
          <p className="px-4 py-2 text-muted-foreground text-xs">{search ? 'No chats match.' : 'Your chats are saved in this browser.'}</p>
        )}
        {groups.map((group) => (
          <SidebarGroup key={group.label}>
            <SidebarGroupLabel>{group.label}</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {group.chats.map((chat) => (
                  <SidebarMenuItem key={chat.id}>
                    <SidebarMenuButton asChild isActive={pathname === `/c/${chat.id}`}>
                      <Link href={`/c/${chat.id}`} onClick={close} title={chat.title}>
                        <span className="truncate">{chat.title}</span>
                      </Link>
                    </SidebarMenuButton>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <SidebarMenuAction showOnHover aria-label={`Actions for ${chat.title}`}>
                          <MoreHorizontalIcon />
                        </SidebarMenuAction>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent side="right" align="start">
                        <DropdownMenuItem variant="destructive" onSelect={() => void remove(chat.id)}>
                          <Trash2Icon />
                          Delete
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </SidebarMenuItem>
                ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        ))}
      </SidebarContent>

      <SidebarFooter>
        <SidebarMenu>
          <SidebarMenuItem>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <SidebarMenuButton>
                  <currentTheme.icon />
                  Theme: {currentTheme.label}
                </SidebarMenuButton>
              </DropdownMenuTrigger>
              <DropdownMenuContent side="top" align="start" className="w-48">
                {THEMES.map((item) => (
                  <DropdownMenuItem key={item.id} onSelect={() => setTheme(item.id)}>
                    <item.icon />
                    {item.label}
                    {item.id === currentTheme.id && <CheckIcon className="ml-auto" />}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          </SidebarMenuItem>
          {session.loaded && (
            <SidebarMenuItem>
              {session.signedIn ? (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <SidebarMenuButton size="lg">
                      <ServerIcon />
                      <span className="flex min-w-0 flex-col leading-tight">
                        <span className="text-muted-foreground text-xs">Signed in to</span>
                        <span className="truncate">{session.server}</span>
                      </span>
                    </SidebarMenuButton>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent side="top" align="start" className="w-56">
                    <DropdownMenuLabel className="font-normal text-muted-foreground text-xs">
                      To use another system, sign out and sign in again.
                    </DropdownMenuLabel>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem onSelect={() => void signOut()}>
                      <LogOutIcon />
                      Sign out
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              ) : (
                <SidebarMenuButton asChild className="bg-sidebar-primary text-sidebar-primary-foreground hover:bg-sidebar-primary/90 hover:text-sidebar-primary-foreground">
                  <a href="/api/auth/signin">
                    <LogInIcon />
                    Sign in to IBM i
                  </a>
                </SidebarMenuButton>
              )}
            </SidebarMenuItem>
          )}
        </SidebarMenu>
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}
