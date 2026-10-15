'use client';

import { useChat, type UseChatHelpers } from '@ai-sdk/react';
import { DefaultChatTransport, type UIMessage } from 'ai';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { setDuration } from '@/lib/client/clock';
import { addExport, addHistory } from '@/lib/client/store';
import { currentSettings } from '@/lib/client/settings';
import { MODEL_KEY_HEADER, providerNeedsKey } from '@/lib/providers';
import { readToolResult, sqlOf } from '@/lib/results';

interface SessionState {
  loaded: boolean;
  signedIn: boolean;
  server?: string;
  customModelBaseUrls: string[];
  signInError?: string;
}

interface AppState {
  session: SessionState;
  refreshSession: () => void;
  signOut: () => Promise<void>;
  chat: UseChatHelpers<UIMessage>;
  /** Send a message with the model and key from Settings. */
  send: (text: string) => Promise<void>;
  /** Text to put in the chat input, for example from "Ask about this". */
  draft: string;
  setDraft: (text: string) => void;
  settingsOpen: boolean;
  setSettingsOpen: (open: boolean) => void;
}

const AppContext = createContext<AppState | undefined>(undefined);

/**
 * The app state from AppStateProvider.
 *
 * @returns Session, chat and settings state
 */
export function useAppState(): AppState {
  const state = useContext(AppContext);
  if (!state) {
    throw new Error('useAppState must be used inside AppStateProvider');
  }
  return state;
}

type ToolPart = Extract<UIMessage['parts'][number], { type: 'dynamic-tool' }>;

function toolParts(messages: UIMessage[]): ToolPart[] {
  return messages.flatMap((message) => message.parts.filter((part): part is ToolPart => part.type === 'dynamic-tool'));
}

/** Keeps the sign-in state and the chat across page changes. */
export function AppStateProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<SessionState>({ loaded: false, signedIn: false, customModelBaseUrls: [] });
  const [draft, setDraft] = useState('');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const started = useRef(new Map<string, number>());
  const recorded = useRef(new Set<string>());

  const refreshSession = useCallback(() => {
    fetch('/api/session', { cache: 'no-store' })
      .then((response) => response.json() as Promise<Omit<SessionState, 'loaded'>>)
      .then((data) => setSession((current) => ({ ...current, ...data, loaded: true })))
      .catch(() => setSession((current) => ({ ...current, loaded: true })));
  }, []);

  useEffect(() => {
    const signInError = new URLSearchParams(window.location.search).get('signin_error') ?? undefined;
    if (signInError) {
      window.history.replaceState(null, '', window.location.pathname);
    }
    fetch('/api/session', { cache: 'no-store' })
      .then((response) => response.json() as Promise<Omit<SessionState, 'loaded'>>)
      .then((data) => setSession((current) => ({ ...current, ...data, signInError, loaded: true })))
      .catch(() => setSession((current) => ({ ...current, signInError, loaded: true })));
  }, []);

  const signOut = useCallback(async () => {
    await fetch('/api/auth/signout', { method: 'POST' });
    setSession((current) => ({ ...current, signedIn: false }));
  }, []);

  const transport = useMemo(() => new DefaultChatTransport<UIMessage>({ api: '/api/chat' }), []);
  const chat = useChat<UIMessage>({
    id: 'main',
    transport,
    onError: (error) => {
      if (/"signIn"\s*:\s*true/.test(error.message)) {
        setSession((current) => ({ ...current, signedIn: false }));
      }
    },
  });

  const send = useCallback(
    async (text: string) => {
      const settings = currentSettings();
      const model = settings.models[settings.provider];
      const apiKey = settings.keys[settings.provider] ?? '';
      if (!model || (providerNeedsKey(settings.provider) && !apiKey)) {
        setSettingsOpen(true);
        return;
      }
      await chat.sendMessage(
        { text },
        {
          headers: { [MODEL_KEY_HEADER]: apiKey },
          body: {
            choice: { provider: settings.provider, model, baseUrl: settings.baseUrl },
          },
        },
      );
    },
    [chat],
  );

  // Time each tool call and record it in history once its result arrives
  useEffect(() => {
    const now = Date.now();
    for (const part of toolParts(chat.messages)) {
      if (!started.current.has(part.toolCallId)) {
        started.current.set(part.toolCallId, now);
      }
      if ((part.state !== 'output-available' && part.state !== 'output-error') || recorded.current.has(part.toolCallId)) {
        continue;
      }
      recorded.current.add(part.toolCallId);
      const durationMs = now - (started.current.get(part.toolCallId) ?? now);
      setDuration(part.toolCallId, durationMs);
      const input = (part.input ?? {}) as Record<string, unknown>;
      const view = part.state === 'output-available' ? readToolResult(part.output) : undefined;
      void addHistory({
        id: part.toolCallId,
        at: now,
        tool: part.toolName,
        input,
        ok: view?.ok ?? false,
        rowCount: view?.rowCount,
        truncated: view?.truncated,
        durationMs,
        error: view?.error?.message ?? (part.state === 'output-error' ? part.errorText : undefined),
        source: 'chat',
      });
      if (view?.exportFile) {
        void addExport({ ...view.exportFile, at: now, tool: part.toolName, sql: sqlOf(input), input });
      }
    }
  }, [chat.messages]);

  const value: AppState = {
    session,
    refreshSession,
    signOut,
    chat,
    send,
    draft,
    setDraft,
    settingsOpen,
    setSettingsOpen,
  };
  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}
