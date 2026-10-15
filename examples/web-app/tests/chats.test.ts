import type { UIMessage } from 'ai';
import { describe, expect, it } from 'vitest';
import { chatMatches, chatTitle, groupChats, type ChatRecord } from '../lib/chats';

function user(text: string): UIMessage {
  return { id: crypto.randomUUID(), role: 'user', parts: [{ type: 'text', text }] };
}

function chat(id: string, updatedAt: number, messages: UIMessage[] = [user(id)]): ChatRecord {
  return { id, title: chatTitle(messages), createdAt: updatedAt, updatedAt, messages };
}

describe('chatTitle', () => {
  it('uses the first question, on one line', () => {
    expect(chatTitle([user('Show the 20 most\nrecent orders')])).toBe('Show the 20 most recent orders');
  });

  it('shortens a long question', () => {
    const title = chatTitle([user('Which customers ordered item 1001 in every month of the year, and how much did they pay?')]);
    expect(title.length).toBeLessThanOrEqual(60);
    expect(title.endsWith('…')).toBe(true);
  });

  it('says New chat before the first question', () => {
    expect(chatTitle([])).toBe('New chat');
  });
});

describe('chatMatches', () => {
  const withTool = chat('orders', 0, [
    user('Recent orders'),
    {
      id: 'a1',
      role: 'assistant',
      parts: [
        {
          type: 'dynamic-tool',
          toolName: 'execute_query',
          toolCallId: 't1',
          state: 'output-available',
          input: { sql: 'SELECT ORDERNO FROM MYLIB.ORDERS' },
          output: {},
        },
        { type: 'text', text: 'Here are the newest orders.' },
      ],
    },
  ]);

  it('finds the title, answer text, SQL and tool name, ignoring case', () => {
    expect(chatMatches(withTool, 'recent')).toBe(true);
    expect(chatMatches(withTool, 'NEWEST')).toBe(true);
    expect(chatMatches(withTool, 'mylib.orders')).toBe(true);
    expect(chatMatches(withTool, 'execute_query')).toBe(true);
    expect(chatMatches(withTool, 'CUSTOMERS')).toBe(false);
  });

  it('matches every chat for an empty search', () => {
    expect(chatMatches(withTool, '  ')).toBe(true);
  });
});

describe('groupChats', () => {
  it('groups by age, newest first, and leaves out empty groups', () => {
    const now = new Date(2026, 9, 15, 12).getTime();
    const day = 24 * 60 * 60 * 1000;
    const groups = groupChats(
      [chat('old', now - 90 * day), chat('morning', now - 2 * 60 * 60 * 1000), chat('noon', now), chat('yesterday', now - day), chat('week', now - 4 * day)],
      now,
    );
    expect(groups.map((group) => [group.label, group.chats.map((each) => each.id)])).toEqual([
      ['Today', ['noon', 'morning']],
      ['Yesterday', ['yesterday']],
      ['Previous 7 days', ['week']],
      ['Older', ['old']],
    ]);
  });
});
