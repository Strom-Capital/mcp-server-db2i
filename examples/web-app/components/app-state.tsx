'use client';

import { Chat } from '@ai-sdk/react';
import { DefaultChatTransport, type UIMessage } from 'ai';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { chatTitle } from '@/lib/chats';
import { setDuration } from '@/lib/client/clock';
import { applyDefaults, currentSettings } from '@/lib/client/settings';
import { addExport, saveChat } from '@/lib/client/store';
import { MODEL_KEY_HEADER, providerNeedsKey, type ProviderId } from '@/lib/providers';
import { readToolResult, sqlOf } from '@/lib/results';

interface SessionState {
  loaded: boolean;
  signedIn: boolean;
  server?: string;
  customModelBaseUrls: string[];
  /** Providers the app has its own key for, so users need not enter one. */
  serverKeys: ProviderId[];
  defaultModel?: { provider: ProviderId; model?: string };
  signInError?: string;
}

interface AppState {
  session: SessionState;
  refreshSession: () => void;
  signOut: () => Promise<void>;
  /** The ID the next new chat gets. */
  draftId: string;
  /** Start over with a fresh ID for the next new chat. */
  newDraft: () => void;
  /**
   * The chat with this ID, made on first use.
   *
   * @param id - Chat ID
   * @param saved - Messages and creation time of a saved chat, when it is not open yet
   */
  chatFor: (id: string, saved?: { messages: UIMessage[]; createdAt: number }) => Chat<UIMessage>;
  /** Whether the chat with this ID is open in this tab. */
  hasChat: (id: string) => boolean;
  /** Close a chat, for example after it was deleted. */
  dropChat: (id: string) => void;
  /**
   * Send a message with the model and key from Settings.
   *
   * @returns False when Settings had to open first
   */
  send: (chat: Chat<UIMessage>, text: string) => Promise<boolean>;
  /**
   * Whether a model and, where the provider needs one, a key (the user's or
   * the app's) are set. Opens Settings when they are not.
   */
  ensureModel: () => boolean;
  /** Save an open chat now, for example as soon as a question is asked. */
  persist: (id: string, messages: UIMessage[]) => void;
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
 * @returns Session, chats and settings state
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

const started = new Map<string, number>();
const recorded = new Set<string>();

/**
 * Time each tool call in these messages, and add export_query files to the
 * exports list once their result arrives.
 *
 * @param messages - The messages of the open chat
 */
export function useToolTracking(messages: UIMessage[]): void {
  useEffect(() => {
    const now = Date.now();
    for (const part of toolParts(messages)) {
      if (recorded.has(part.toolCallId)) {
        continue;
      }
      if (!started.has(part.toolCallId)) {
        started.set(part.toolCallId, now);
      }
      if (part.state !== 'output-available' && part.state !== 'output-error') {
        continue;
      }
      recorded.add(part.toolCallId);
      setDuration(part.toolCallId, now - (started.get(part.toolCallId) ?? now));
      const view = part.state === 'output-available' ? readToolResult(part.output) : undefined;
      if (view?.exportFile) {
        const input = (part.input ?? {}) as Record<string, unknown>;
        void addExport({ ...view.exportFile, at: now, tool: part.toolName, sql: sqlOf(input), input });
      }
    }
  }, [messages]);
}

/** Keeps the sign-in state and the open chats across page changes. */
export function AppStateProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<SessionState>({ loaded: false, signedIn: false, customModelBaseUrls: [], serverKeys: [] });
  const [draft, setDraft] = useState('');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [draftId, setDraftId] = useState(() => crypto.randomUUID());
  const chats = useRef(new Map<string, { chat: Chat<UIMessage>; createdAt: number }>());

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
      .then((data) => {
        const provider = data.defaultModel?.provider ?? data.serverKeys?.[0];
        applyDefaults(provider ? { provider, model: data.defaultModel?.provider === provider ? data.defaultModel.model : undefined } : undefined);
        setSession((current) => ({ ...current, ...data, signInError, loaded: true }));
      })
      .catch(() => setSession((current) => ({ ...current, signInError, loaded: true })));
  }, []);

  const signOut = useCallback(async () => {
    await fetch('/api/auth/signout', { method: 'POST' });
    setSession((current) => ({ ...current, signedIn: false }));
  }, []);

  const transport = useMemo(() => new DefaultChatTransport<UIMessage>({ api: '/api/chat' }), []);

  const persist = useCallback((id: string, messages: UIMessage[]) => {
    const open = chats.current.get(id);
    if (!open || messages.length === 0) {
      return;
    }
    void saveChat({ id, title: chatTitle(messages), createdAt: open.createdAt, updatedAt: Date.now(), messages });
  }, []);

  const chatFor = useCallback(
    (id: string, saved?: { messages: UIMessage[]; createdAt: number }) => {
      const open = chats.current.get(id);
      if (open) {
        return open.chat;
      }
      for (const part of toolParts(saved?.messages ?? [])) {
        recorded.add(part.toolCallId);
      }
      const chat = new Chat<UIMessage>({
        id,
        messages: saved?.messages,
        transport,
        onFinish: ({ messages }) => persist(id, messages),
        onError: (error) => {
          if (/"signIn"\s*:\s*true/.test(error.message)) {
            setSession((current) => ({ ...current, signedIn: false }));
          }
        },
      });
      chats.current.set(id, { chat, createdAt: saved?.createdAt ?? Date.now() });
      return chat;
    },
    [persist, transport],
  );

  const hasChat = useCallback((id: string) => chats.current.has(id), []);

  const dropChat = useCallback((id: string) => {
    const open = chats.current.get(id);
    if (open) {
      void open.chat.stop();
      chats.current.delete(id);
    }
  }, []);

  const newDraft = useCallback(() => setDraftId(crypto.randomUUID()), []);

  const serverKeys = session.serverKeys;
  const ensureModel = useCallback(() => {
    const settings = currentSettings();
    const hasKey =
      !providerNeedsKey(settings.provider) || !!settings.keys[settings.provider] || serverKeys.includes(settings.provider);
    const ready = !!settings.models[settings.provider] && hasKey;
    if (!ready) {
      setSettingsOpen(true);
    }
    return ready;
  }, [serverKeys]);

  const send = useCallback(
    async (chat: Chat<UIMessage>, text: string) => {
      if (!ensureModel()) {
        return false;
      }
      const settings = currentSettings();
      const model = settings.models[settings.provider];
      const apiKey = settings.keys[settings.provider] ?? '';
      await chat.sendMessage(
        { text },
        {
          headers: { [MODEL_KEY_HEADER]: apiKey },
          body: {
            choice: { provider: settings.provider, model, baseUrl: settings.baseUrl, effort: settings.efforts?.[settings.provider] },
          },
        },
      );
      return true;
    },
    [ensureModel],
  );

  const value: AppState = {
    session,
    refreshSession,
    signOut,
    draftId,
    newDraft,
    chatFor,
    hasChat,
    dropChat,
    send,
    ensureModel,
    persist,
    draft,
    setDraft,
    settingsOpen,
    setSettingsOpen,
  };
  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}
