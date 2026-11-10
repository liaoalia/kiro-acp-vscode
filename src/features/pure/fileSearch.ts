/**
 * Pure ranking for the `@` file picker. vscode-free; tested in
 * `test/features-contentBlocks.test.ts`.
 */

/** Characters with glob meaning that are stripped from the user's query. */
export function sanitizeQuery(query: string): string {
  return query.replace(/\\/g, "/").replace(/[*?[\]{}()!]/g, "").trim();
}

/** Glob passed to `workspace.findFiles` for a (sanitised) query. */
export function globForQuery(query: string): string {
  const q = sanitizeQuery(query);
  return q.length === 0 ? "**/*" : `**/*${q}*`;
}

export const SEARCH_EXCLUDE = "{**/node_modules/**,**/.git/**,**/dist/**,**/out/**}";

/**
 * Higher is better: basename starts with the query (3), basename contains it
 * (2), path contains it (1), otherwise 0. Case-insensitive; ties are broken by
 * shorter paths in {@link sortByScore}.
 */
export function scoreFileMatch(query: string, relPath: string): number {
  const q = sanitizeQuery(query).toLowerCase();
  if (q.length === 0) {
    return 1;
  }
  const p = relPath.replace(/\\/g, "/").toLowerCase();
  const base = p.slice(p.lastIndexOf("/") + 1);
  if (base.startsWith(q)) {
    return 3;
  }
  if (base.includes(q)) {
    return 2;
  }
  if (p.includes(q)) {
    return 1;
  }
  return 0;
}

/** Sort by {@link scoreFileMatch} descending, then path length, then alphabetically. */
export function sortByScore<T extends { label: string }>(query: string, items: T[]): T[] {
  return [...items]
    .map((item, i) => ({ item, i, score: scoreFileMatch(query, item.label) }))
    .sort(
      (a, b) =>
        b.score - a.score ||
        a.item.label.length - b.item.label.length ||
        a.item.label.localeCompare(b.item.label) ||
        a.i - b.i,
    )
    .map((x) => x.item);
}
