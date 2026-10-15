'use client';

import { useEffect, useRef } from 'react';
import { Streamdown } from 'streamdown';
import { useAppState } from '@/components/app-state';
import { ToolCard } from '@/components/tool-card';

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

export default function ChatPage() {
  const { chat, send, draft, setDraft, session } = useAppState();
  const { messages, status, stop, error, setMessages, clearError } = chat;
  const busy = status === 'submitted' || status === 'streaming';
  const bottom = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    bottom.current?.scrollIntoView({ block: 'end' });
  }, [messages]);

  useEffect(() => {
    if (draft) {
      input.current?.focus();
    }
  }, [draft]);

  function submit() {
    const text = draft.trim();
    if (!text || busy) {
      return;
    }
    setDraft('');
    void send(text);
  }

  return (
    <div className="mx-auto flex h-full max-w-5xl flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-6">
        {messages.length === 0 ? (
          <div className="mx-auto mt-12 max-w-xl text-center">
            <h1 className="text-2xl font-semibold">Ask about your IBM i data</h1>
            <p className="mt-2 text-muted-foreground">
              {session.signedIn
                ? 'The assistant finds the right tables, writes the SQL and shows the results as tables you can sort, filter and download.'
                : 'Sign in to the IBM i first, then choose a model in the top right.'}
            </p>
            <div className="mt-6 grid gap-2 sm:grid-cols-2">
              {EXAMPLES.map((example) => (
                <button
                  key={example}
                  type="button"
                  onClick={() => setDraft(example)}
                  className="rounded-sm border border-line bg-surface px-3 py-2 text-left text-sm hover:border-fg"
                >
                  {example}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-6">
            {messages.map((message) => (
              <div key={message.id} className={message.role === 'user' ? 'flex justify-end' : ''}>
                {message.role === 'user' ? (
                  <div className="max-w-[80%] rounded-sm bg-surface px-3 py-2 whitespace-pre-wrap">
                    {message.parts.map((part, index) => (part.type === 'text' ? <span key={index}>{part.text}</span> : null))}
                  </div>
                ) : (
                  <div className="min-w-0">
                    {message.parts.map((part, index) => {
                      if (part.type === 'text') {
                        return (
                          <Streamdown key={index} isAnimating={busy && message.id === messages.at(-1)?.id}>
                            {part.text}
                          </Streamdown>
                        );
                      }
                      if (part.type === 'reasoning' && part.text.trim()) {
                        return (
                          <details key={index} className="my-2 text-sm text-muted-foreground">
                            <summary className="cursor-pointer">Reasoning</summary>
                            <p className="mt-1 whitespace-pre-wrap">{part.text}</p>
                          </details>
                        );
                      }
                      if (part.type === 'dynamic-tool') {
                        return (
                          <ToolCard
                            key={part.toolCallId}
                            toolCallId={part.toolCallId}
                            toolName={part.toolName}
                            state={part.state}
                            input={part.input}
                            output={part.state === 'output-available' ? part.output : undefined}
                            errorText={part.state === 'output-error' ? part.errorText : undefined}
                          />
                        );
                      }
                      return null;
                    })}
                  </div>
                )}
              </div>
            ))}
            {status === 'submitted' && <p className="animate-pulse text-sm text-muted-foreground">Thinking...</p>}
          </div>
        )}
        {error && (
          <div role="alert" className="mt-4 flex items-start gap-3 rounded-sm border border-error/40 bg-error/5 px-3 py-2 text-sm">
            <p className="flex-1 text-error">{errorText(error)}</p>
            <button type="button" className="text-muted-foreground hover:text-fg" onClick={() => clearError()}>
              Dismiss
            </button>
          </div>
        )}
        <div ref={bottom} />
      </div>

      <form
        className="border-t border-line px-4 py-3"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <div className="flex items-end gap-2">
          <textarea
            ref={input}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                submit();
              }
            }}
            rows={Math.min(6, Math.max(1, draft.split('\n').length))}
            placeholder={session.signedIn ? 'Ask a question about your data' : 'Sign in to the IBM i to start'}
            aria-label="Message"
            className="min-h-10 flex-1 resize-none rounded-sm border border-line bg-surface px-3 py-2 outline-none focus:border-accent"
          />
          {busy ? (
            <button type="button" onClick={() => void stop()} className="h-10 rounded-sm border border-line px-4 hover:border-fg">
              Stop
            </button>
          ) : (
            <button
              type="submit"
              disabled={!draft.trim() || !session.signedIn}
              className="h-10 rounded-sm bg-accent px-4 font-medium text-on-accent hover:bg-accent-strong disabled:opacity-50"
            >
              Send
            </button>
          )}
        </div>
        <div className="mt-2 flex justify-between text-xs text-muted-foreground">
          <span>Enter sends, Shift+Enter adds a line. Results come from your IBM i with your own authority.</span>
          {messages.length > 0 && !busy && (
            <button type="button" className="hover:text-fg" onClick={() => setMessages([])}>
              New chat
            </button>
          )}
        </div>
      </form>
    </div>
  );
}
