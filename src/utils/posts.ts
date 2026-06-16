import { getCollection, type CollectionEntry } from 'astro:content';

export type Post = CollectionEntry<'posts'>;

/** Drafts are visible in dev, excluded from prod builds, RSS, and sitemap. */
export async function getPosts(): Promise<Post[]> {
  const posts = await getCollection('posts', (post) => import.meta.env.DEV || !post.data.draft);
  return posts.sort((a, b) => b.data.pubDate.valueOf() - a.data.pubDate.valueOf());
}

/** Draft posts only — served unlisted + noindexed under /drafts in prod. */
export async function getDrafts(): Promise<Post[]> {
  const posts = await getCollection('posts', (post) => post.data.draft);
  return posts.sort((a, b) => b.data.pubDate.valueOf() - a.data.pubDate.valueOf());
}

/** Every post regardless of draft state, newest first — for /drafts series previews. */
export async function getAllPosts(): Promise<Post[]> {
  const posts = await getCollection('posts');
  return posts.sort((a, b) => b.data.pubDate.valueOf() - a.data.pubDate.valueOf());
}

/** Members of a named series, ordered by series.order (independent of pubDate). */
export function seriesPosts(posts: Post[], name: string): Post[] {
  return posts
    .filter((p) => p.data.series?.name === name)
    .sort((a, b) => (a.data.series?.order ?? 0) - (b.data.series?.order ?? 0));
}

/** URL slug for a series display name ("Effect, from zero" → "effect-from-zero"). */
export const seriesSlug = (name: string): string =>
  name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

/** Every distinct series with its ordered parts, sorted by name. */
export function allSeries(posts: Post[]): { name: string; slug: string; parts: Post[] }[] {
  const names = [...new Set(posts.flatMap((p) => (p.data.series ? [p.data.series.name] : [])))];
  return names
    .map((name) => ({ name, slug: seriesSlug(name), parts: seriesPosts(posts, name) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** A rendered series entry. Draft parts link to /drafts (the only access until shipped). */
export interface SeriesPart {
  id: string;
  title: string;
  href: string;
  draft: boolean;
  current: boolean;
}

/** Build series entries from the full arc: live parts → /posts, drafts → /drafts. */
export function toSeriesParts(posts: Post[], name: string, currentId: string): SeriesPart[] {
  return seriesPosts(posts, name).map((p) => ({
    id: p.id,
    title: p.data.title,
    href: p.data.draft ? `/drafts/${p.id}/` : `/posts/${p.id}/`,
    draft: p.data.draft,
    current: p.id === currentId,
  }));
}

/** Fail the build on a malformed series (duplicate order within one series). */
export function assertSeriesIntegrity(posts: Post[]): void {
  const orders = new Map<string, number[]>();
  for (const p of posts) {
    const s = p.data.series;
    if (!s) continue;
    orders.set(s.name, [...(orders.get(s.name) ?? []), s.order]);
  }
  for (const [name, list] of orders) {
    const dupes = [...new Set(list.filter((o, i) => list.indexOf(o) !== i))];
    if (dupes.length > 0) {
      throw new Error(`Series "${name}" has duplicate order value(s): ${dupes.join(', ')}`);
    }
  }
}

export const isoDate = (d: Date): string => d.toISOString().slice(0, 10);

export function readingTime(body: string): number {
  const words = body.trim().split(/\s+/).length;
  return Math.max(1, Math.round(words / 200));
}
