import type { AstroComponent } from '@lucide/astro';
import BookOpenText from '@lucide/astro/icons/book-open-text';
import FileCode from '@lucide/astro/icons/file-code';
import KeyRound from '@lucide/astro/icons/key-round';
import Lock from '@lucide/astro/icons/lock';
import MessageCircleQuestionMark from '@lucide/astro/icons/message-circle-question-mark';
import Network from '@lucide/astro/icons/network';
import Rocket from '@lucide/astro/icons/rocket';
import SearchCheck from '@lucide/astro/icons/search-check';
import ShieldCheck from '@lucide/astro/icons/shield-check';
import Telescope from '@lucide/astro/icons/telescope';
import Terminal from '@lucide/astro/icons/terminal';
import Timer from '@lucide/astro/icons/timer';
import { getCollection, type CollectionEntry } from 'astro:content';

export type Post = CollectionEntry<'blog'>;

/** Published posts, newest first. Posts on the same day are ordered by the time in `date`, then by file name. */
export async function getPosts(): Promise<Post[]> {
  const posts = await getCollection('blog', ({ data }) => !data.draft);
  return posts.sort((a, b) => b.data.date.getTime() - a.data.date.getTime() || b.filePath!.localeCompare(a.filePath!));
}

export const audienceLabel: Record<Post['data']['audience'], string> = {
  ibmi: 'For IBM i teams',
  business: 'For business teams',
};

/** Icon components for the `icon` names allowed in the blog schema (src/content.config.ts). */
export const postIcons: Record<Post['data']['icon'], AstroComponent> = {
  'book-open-text': BookOpenText,
  'file-code': FileCode,
  'key-round': KeyRound,
  lock: Lock,
  'message-circle-question-mark': MessageCircleQuestionMark,
  network: Network,
  rocket: Rocket,
  'search-check': SearchCheck,
  'shield-check': ShieldCheck,
  telescope: Telescope,
  terminal: Terminal,
  timer: Timer,
};
