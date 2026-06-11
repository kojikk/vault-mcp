import matter from "gray-matter";

/**
 * Extraction-side link/tag/frontmatter parser for the graph builder.
 *
 * backlinks.ts owns the *replacement* concern (repairing links on moves) and keeps its
 * own regexes; this module owns *extraction*. The wikilink grammar is the same:
 * [[target]], [[target|alias]], [[target#heading]], with a leading ! marking an embed.
 */

export interface ParsedRefs {
  /** Wikilink / markdown-link targets (heading/alias stripped, extension kept as written). */
  links: { target: string; embed: boolean }[];
  /** Tag names without '#', from both frontmatter `tags` and inline #tags. */
  tags: string[];
  /** Frontmatter aliases (Obsidian `aliases` key, string or list). */
  aliases: string[];
  /** True when frontmatter declares `type: entity`. */
  entity: boolean;
}

const WIKILINK_RE = /(!?)\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|[^\]]+)?\]\]/g;
const MDLINK_RE = /\]\(([^)\s]+\.md)\)/gi;
/** Inline tags: #word with unicode letters/digits, nested via '/'. Not inside code spans (best effort). */
const TAG_RE = /(^|[\s(])#([\p{L}\p{N}_][\p{L}\p{N}_/-]*)/gu;

function asStringList(v: unknown): string[] {
  if (typeof v === "string") return v.trim() ? [v.trim()] : [];
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === "string").map((x) => x.trim()).filter(Boolean);
  return [];
}

/** Parse one markdown document into the references the graph builder needs. */
export function parseRefs(content: string): ParsedRefs {
  let data: Record<string, unknown> = {};
  let body = content;
  try {
    const parsed = matter(content);
    data = parsed.data as Record<string, unknown>;
    body = parsed.content;
  } catch {
    // Malformed frontmatter: treat the whole file as body. Content is data, not a failure.
  }

  const links: { target: string; embed: boolean }[] = [];
  let m: RegExpExecArray | null;
  WIKILINK_RE.lastIndex = 0;
  while ((m = WIKILINK_RE.exec(body)) !== null) {
    const target = (m[2] ?? "").trim();
    if (target) links.push({ target, embed: m[1] === "!" });
  }
  MDLINK_RE.lastIndex = 0;
  while ((m = MDLINK_RE.exec(body)) !== null) {
    const target = (m[1] ?? "").trim();
    if (target) links.push({ target, embed: false });
  }

  const tags = new Set<string>(asStringList(data.tags).map((t) => t.replace(/^#/, "")));
  TAG_RE.lastIndex = 0;
  while ((m = TAG_RE.exec(body)) !== null) {
    const tag = m[2] ?? "";
    // Pure-numeric "#2026" is a heading/number, not a tag (Obsidian requires a letter).
    if (tag && /\p{L}/u.test(tag)) tags.add(tag);
  }

  return {
    links,
    tags: [...tags],
    aliases: asStringList(data.aliases),
    entity: data.type === "entity",
  };
}
