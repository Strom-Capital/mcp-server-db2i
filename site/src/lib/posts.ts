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
