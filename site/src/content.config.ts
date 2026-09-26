import { defineCollection } from 'astro:content';
import { glob } from 'astro/loaders';
import { z } from 'astro/zod';

/** Blog posts: `src/content/blog/YYYY-MM-DD-slug.md`. Tone and rules: local/brand.md. */
const blog = defineCollection({
  loader: glob({
    pattern: '**/[^_]*.md',
    base: './src/content/blog',
    // Drop the date prefix from the URL: 2026-09-25-sign-in.md -> /blog/sign-in
    generateId: ({ entry }) => entry.replace(/\.md$/, '').replace(/^\d{4}-\d{2}-\d{2}-/, ''),
  }),
  schema: z.object({
    title: z.string(),
    description: z.string(),
    date: z.coerce.date(),
    /** Main reader: IBM i teams or business readers. */
    audience: z.enum(['ibmi', 'business']),
    /** Lucide icon shown on the post's card. Add new names to `postIcons` in src/lib/posts.ts too. */
    icon: z.enum([
      'book-open-text', 'file-code', 'key-round', 'lock', 'message-circle-question-mark', 'network',
      'rocket', 'search-check', 'shield-check', 'telescope', 'terminal', 'timer',
    ]),
    tags: z.array(z.string()).default([]),
    /** Where the post first appeared, if it was published elsewhere first. */
    originalUrl: z.url().optional(),
    draft: z.boolean().default(false),
  }),
});

export const collections = { blog };
