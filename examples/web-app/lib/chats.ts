import type { UIMessage } from 'ai';
import { sqlOf } from './results';

/** A saved conversation. */
export interface ChatRecord {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: UIMessage[];
}

/** Chats that share a date label in the sidebar. */
export interface ChatGroup {
  label: string;
  chats: ChatRecord[];
}

const TITLE_LENGTH = 60;
const DAY = 24 * 60 * 60 * 1000;

function textOf(message: UIMessage): string {
  return message.parts
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join(' ');
}

/**
 * The title for a chat: its first question, shortened.
 *
 * @param messages - The chat's messages
 * @returns The title, or "New chat" before the first question
 */
export function chatTitle(messages: UIMessage[]): string {
  const first = messages.find((message) => message.role === 'user');
  const text = first ? textOf(first).replace(/\s+/g, ' ').trim() : '';
  if (!text) {
    return 'New chat';
  }
  return text.length > TITLE_LENGTH ? `${text.slice(0, TITLE_LENGTH - 1).trimEnd()}…` : text;
}

/**
 * Whether a chat matches a search: its title, the text of its messages, or
 * the SQL and tool names of its tool calls.
 *
 * @param chat - The chat
 * @param needle - The search text; empty matches every chat
 * @returns True when it matches
 */
export function chatMatches(chat: ChatRecord, needle: string): boolean {
  const query = needle.trim().toLowerCase();
  if (!query) {
    return true;
  }
  if (chat.title.toLowerCase().includes(query)) {
    return true;
  }
  return chat.messages.some((message) =>
    message.parts.some((part) => {
      if (part.type === 'text') {
        return part.text.toLowerCase().includes(query);
      }
      if (part.type === 'dynamic-tool') {
        return part.toolName.toLowerCase().includes(query) || (sqlOf(part.input)?.toLowerCase().includes(query) ?? false);
      }
      return false;
    }),
  );
}

/**
 * Group chats, newest first, under Today, Yesterday, Previous 7 days,
 * Previous 30 days and Older.
 *
 * @param chats - The chats, in any order
 * @param now - The current time
 * @returns The groups that have chats
 */
export function groupChats(chats: ChatRecord[], now: number): ChatGroup[] {
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const start = today.getTime();
  const bounds: [string, number][] = [
    ['Today', start],
    ['Yesterday', start - DAY],
    ['Previous 7 days', start - 7 * DAY],
    ['Previous 30 days', start - 30 * DAY],
    ['Older', Number.NEGATIVE_INFINITY],
  ];
  const groups = bounds.map(([label]) => ({ label, chats: [] as ChatRecord[] }));
  for (const chat of [...chats].sort((a, b) => b.updatedAt - a.updatedAt)) {
    const index = bounds.findIndex(([, from]) => chat.updatedAt >= from);
    groups[index]?.chats.push(chat);
  }
  return groups.filter((group) => group.chats.length > 0);
}
