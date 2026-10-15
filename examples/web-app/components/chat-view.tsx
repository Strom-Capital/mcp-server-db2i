'use client';

import { useChat, type Chat } from '@ai-sdk/react';
import type { UIMessage } from 'ai';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { Conversation, ConversationContent, ConversationScrollButton } from '@/components/ai-elements/conversation';
import { Message, MessageContent, MessageResponse } from '@/components/ai-elements/message';
import {
  PromptInput,
  PromptInputBody,
  PromptInputFooter,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools,
} from '@/components/ai-elements/prompt-input';
import { EffortSelect } from '@/components/effort-select';
import { Reasoning, ReasoningContent, ReasoningTrigger } from '@/components/ai-elements/reasoning';
import { Shimmer } from '@/components/ai-elements/shimmer';
import { Suggestion, Suggestions } from '@/components/ai-elements/suggestion';
import { Button } from '@/components/ui/button';
import { loadChat } from '@/lib/client/store';
import { useAppState, useToolTracking } from './app-state';
import { Logo } from './logo';
import { ToolCard } from './tool-card';

const EXAMPLES = [
  'Which libraries can I query, and what are they for?',
  'Find the tables that hold customer orders and describe how they join.',
  'Show the 20 most recent orders in MYLIB.ORDERS.',
  'Export every open order to an Excel file.',
];

function errorText(error: Error): string {
  try {
    const parsed = JSON.parse(error.message) as { error?: string };
    if (parsed.error) {
      return parsed.error;
    }
  } catch {
    // Not JSON: a stream error message
  }
  return error.message;
}

/**
 * A chat page: a new chat at `/`, or a saved one at `/c/<id>`.
 *
 * @param chatId - The saved chat to open; a new chat when left out
 */
export function ChatView({ chatId }: { chatId?: string }) {
  const { draftId, newDraft, chatFor, hasChat } = useAppState();
  const [loaded, setLoaded] = useState<{ id: string; chat?: Chat<UIMessage>; missing?: boolean }>();

  useEffect(() => {
    if (!chatId) {
      return;
    }
    // The new chat just got its own address: the next new chat needs another ID
    if (chatId === draftId) {
      newDraft();
    }
    if (hasChat(chatId)) {
      return;
    }
    let cancelled = false;
    void loadChat(chatId).then((saved) => {
      if (!cancelled) {
        setLoaded(saved ? { id: chatId, chat: chatFor(chatId, saved) } : { id: chatId, missing: true });
      }
    });
    return () => {
      cancelled = true;
    };
  }, [chatId, draftId, newDraft, chatFor, hasChat]);

  if (!chatId) {
    return <ChatConversation key={draftId} chat={chatFor(draftId)} isNew />;
  }
  if (hasChat(chatId)) {
    return <ChatConversation key={chatId} chat={chatFor(chatId)} />;
  }
  if (loaded?.id === chatId && loaded.missing) {
    return <p className="mt-16 text-center text-muted-foreground">This chat is not saved in this browser.</p>;
  }
  if (loaded?.id === chatId && loaded.chat) {
    return <ChatConversation key={chatId} chat={loaded.chat} />;
  }
  return null;
}

function ChatConversation({ chat, isNew = false }: { chat: Chat<UIMessage>; isNew?: boolean }) {
  const { send, persist, draft, setDraft, session, ensureModel } = useAppState();
  const router = useRouter();
  const { messages, status, stop, error, clearError } = useChat({ chat });
  const busy = status === 'submitted' || status === 'streaming';
  const input = useRef<HTMLTextAreaElement>(null);
  useToolTracking(messages);

  useEffect(() => {
    if (status === 'submitted') {
      persist(chat.id, chat.messages);
    }
  }, [status, chat, persist]);

  useEffect(() => {
    if (draft) {
      input.current?.focus();
    }
  }, [draft]);

  function submit(text: string) {
    const question = text.trim();
    if (!question || busy || !session.signedIn || !ensureModel()) {
      return;
    }
    setDraft('');
    void send(chat, question);
    if (isNew) {
      router.replace(`/c/${chat.id}`);
    }
  }

  const prompt = (
    <PromptInput onSubmit={(message) => submit(message.text)} className="bg-card">
      <PromptInputBody>
        <PromptInputTextarea
          ref={input}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          disabled={!session.signedIn}
          placeholder={session.signedIn ? 'Ask a question about your data' : 'Sign in to the IBM i to start'}
          aria-label="Message"
        />
      </PromptInputBody>
      <PromptInputFooter>
        <PromptInputTools className="min-w-0 text-muted-foreground text-xs">
          <EffortSelect variant="prompt" />
        </PromptInputTools>
        <PromptInputSubmit status={status} onStop={() => void stop()} disabled={!busy && (!draft.trim() || !session.signedIn)} />
      </PromptInputFooter>
    </PromptInput>
  );

  const alert = error && (
    <div role="alert" className="flex items-start gap-3 rounded-lg border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm">
      <p className="flex-1 text-destructive">{errorText(error)}</p>
      <Button variant="ghost" size="sm" onClick={() => clearError()}>
        Dismiss
      </Button>
    </div>
  );

  if (messages.length === 0) {
    return (
      <div className="mx-auto flex h-full w-full max-w-3xl flex-col justify-center gap-6 px-4 pb-16">
        <div className="flex flex-col items-center gap-3 text-center">
          <Logo variant="mark" className="h-10" />
          <h1 className="font-semibold text-2xl">Ask about your IBM i data</h1>
          <p className="max-w-xl text-muted-foreground">
            {session.signedIn
              ? 'The assistant finds the right tables, writes the SQL and shows the results as tables you can sort, filter and download.'
              : 'Sign in to the IBM i first, then choose a model at the top.'}
          </p>
        </div>
        {session.loaded && !session.signedIn ? (
          <Button asChild size="lg" className="self-center">
            <a href="/api/auth/signin">Sign in to IBM i</a>
          </Button>
        ) : (
          prompt
        )}
        {alert}
        <Suggestions className="w-full flex-wrap justify-center">
          {EXAMPLES.map((example) => (
            <Suggestion key={example} suggestion={example} onClick={setDraft} />
          ))}
        </Suggestions>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <Conversation className="min-h-0">
        <ConversationContent className="mx-auto w-full max-w-3xl gap-6 px-4 py-6">
          {messages.map((message) => (
            <Message key={message.id} from={message.role} className={message.role === 'assistant' ? 'max-w-full' : undefined}>
              <MessageContent className={message.role === 'assistant' ? 'w-full' : undefined}>
                {message.parts.map((part, index) => {
                  if (part.type === 'text') {
                    return message.role === 'user' ? (
                      <p key={index} className="whitespace-pre-wrap">
                        {part.text}
                      </p>
                    ) : (
                      <MessageResponse key={index} isAnimating={busy && message.id === messages.at(-1)?.id}>
                        {part.text}
                      </MessageResponse>
                    );
                  }
                  if (part.type === 'reasoning' && part.text.trim()) {
                    return (
                      <Reasoning key={index} isStreaming={busy && part.state === 'streaming'}>
                        <ReasoningTrigger />
                        <ReasoningContent>{part.text}</ReasoningContent>
                      </Reasoning>
                    );
                  }
                  if (part.type === 'dynamic-tool') {
                    return <ToolCard key={part.toolCallId} part={part} />;
                  }
                  return null;
                })}
              </MessageContent>
            </Message>
          ))}
          {status === 'submitted' && <Shimmer className="text-sm">Thinking…</Shimmer>}
          {alert}
        </ConversationContent>
        <ConversationScrollButton />
      </Conversation>
      <div className="mx-auto w-full max-w-3xl px-4 pb-4">{prompt}</div>
    </div>
  );
}
