/**
 * Global web search — real internet retrieval for TixlogicSearch.
 *
 * How it honestly works (no fabricated results):
 *  1. DISCOVERY: the query is dispatched in parallel to several public,
 *     documented sources of the live internet:
 *       - DuckDuckGo (Lite/HTML endpoints — general web index)
 *       - Bing        (general web index, HTML endpoint)
 *       - Wikipedia   (MediaWiki search API — world knowledge)
 *       - Hacker News (Algolia public search API — tech discussion)
 *       - GitHub      (public repository search API — code & projects)
 *       - Reddit      (public JSON search — communities)
 *       - Stack Exchange (public API — Q&A)
 *     Every source is best-effort: failures/timeouts are reported truthfully
 *     in `engines[]`, never hidden and never faked.
 *  2. MERGE: listings are canonicalized, deduplicated across engines and
 *    combined with an upstream-rank signal.
 *  3. ENRICH (optional): top pages are actually fetched through the same
 *    SSRF-hardened, robots.txt-respecting fetcher used by the crawler, so the
 *    BM25/TF-IDF engine ranks against real page text — not just snippets.
 *  4. RANK: the merged corpus is indexed into the custom inverted index and
 *    scored with the identical ranking pipeline used everywhere else.
 *  5. CACHE: results are memoized per (query, site) for a short TTL so repeat
 *    searches are fast and upstream services are treated politely.
 */

import type {
  EngineOutcome,
  GlobalSearchResponse,
  SearchDocument,
  WebEngineId,
  WebListing,
} from "@/types";
import { secureFetch } from "@/lib/crawler/fetcher";
import { validateUrlResolved, canonicalizeUrl } from "@/lib/crawler/url-validator";
import { serverSearchBundle } from "@/lib/search/server-search-service";
import type { EngineOptions } from "@/lib/search/engine";

const FETCH_TIMEOUT_MS = 9000;
const MAX_RESPONSE_BYTES = 700 * 1024;
const UA_BROWSER =
  "Mozilla/5.0 (X11; Linux x86_64; rv:129.0) Gecko/20100101 Firefox/129.0";

/* ----------------------------- small utilities ---------------------------- */

function decodeEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&#\d+;/g, " ");
}

function stripTags(s: string): string {
  return decodeEntities(s.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1).trimEnd() + "…";
}

async function fetchText(url: string, headers: Record<string, string> = {}): Promise<string | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        signal: controller.signal,
        redirect: "follow",
        credentials: "omit",
        headers: { "User-Agent": UA_BROWSER, Accept: "*/*", ...headers },
      });
      if (!res.ok) return null;
      return await res.text();
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return null;
  }
}

async function fetchJson<T>(url: string): Promise<T | null> {
  const text = await fetchText(url, { Accept: "application/json" });
  if (!text) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

/** SSRF-safe check before we hand a discovered URL to the enricher. */
async function isPublicHttpUrl(raw: string): Promise<boolean> {
  try {
    const u = new URL(raw);
    if (u.protocol !== "http:" && u.protocol !== "https:") return false;
    const v = await validateUrlResolved(raw);
    return v.ok;
  } catch {
    return false;
  }
}

/* ------------------------------- discovery -------------------------------- */

interface EngineResult {
  listings: WebListing[];
  outcome: EngineOutcome;
}

function ddgRedirectTarget(href: string): string | null {
  // DuckDuckGo wraps links as //duckduckgo.com/l/?uddg=<encoded>&rut=...
  try {
    const abs = href.startsWith("//") ? "https:" + href : href;
    const u = new URL(abs);
    const target = u.searchParams.get("uddg");
    return target && /^https?:\/\//i.test(target) ? target : null;
  } catch {
    return null;
  }
}

function isAdUrl(u: string): boolean {
  try {
    const host = new URL(u).hostname.toLowerCase();
    return host === "duckduckgo.com" || host.endsWith(".duckduckgo.com") || host.includes("bing.com/js/") || /[?&]ad_domain=/.test(u);
  } catch {
    return true;
  }
}

async function searchDuckDuckGo(query: string, site?: string): Promise<EngineResult> {
  const started = Date.now();
  const q = site ? `${query} site:${site}` : query;
  const endpoints = [
    `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(q)}`,
    `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`,
  ];
  let html: string | null = null;
  for (const ep of endpoints) {
    html = await fetchText(ep);
    if (html && /result-link|result__body|web-result/i.test(html)) break;
  }
  if (!html) {
    return {
      listings: [],
      outcome: { engine: "duckduckgo", ok: false, hits: 0, error: "Upstream unreachable or blocked", tookMs: Date.now() - started },
    };
  }
  const listings: WebListing[] = [];
  // lite layout: <a ... class='result-link'>title</a> + <td class='result-snippet'>
  const linkRe = /href=['"]([^'"]+)['"][^>]*class=['"]result-link['"][^>]*>([\s\S]*?)<\/a>/gi;
  const snippetRe = /class=['"]result-snippet['"][^>]*>([\s\S]*?)<\/(?:td|div)>/gi;
  const snippets: string[] = [];
  let sm: RegExpExecArray | null;
  while ((sm = snippetRe.exec(html)) !== null) snippets.push(stripTags(sm[1]));
  let m: RegExpExecArray | null;
  let idx = 0;
  while ((m = linkRe.exec(html)) !== null && idx < 25) {
    idx++;
    let url = decodeEntities(m[1]);
    if (url.startsWith("//")) url = "https:" + url;
    const unwrapped = ddgRedirectTarget(url);
    if (unwrapped) url = unwrapped;
    if (!/^https?:\/\//i.test(url) || isAdUrl(url)) continue;
    const title = stripTags(m[2]);
    if (!title) continue;
    listings.push({ url, title, snippet: snippets[idx - 1] ?? "", engine: "duckduckgo", scoreHint: Math.max(0.15, 1 - idx * 0.04) });
  }
  // html layout fallback (result__a / result__snippet)
  if (listings.length === 0) {
    const aRe = /<a[^>]+class=['"][^'"]*result__a[^'"]*['"][^>]*href=['"]([^'"]+)['"][^>]*>([\s\S]*?)<\/a>/gi;
    const sRe = /class=['"][^'"]*result__snippet[^'"]*['"][^>]*>([\s\S]*?)<\/a>/gi;
    const s2: string[] = [];
    let m2: RegExpExecArray | null;
    while ((m2 = sRe.exec(html)) !== null) s2.push(stripTags(m2[1]));
    let i = 0;
    while ((m2 = aRe.exec(html)) !== null && i < 25) {
      i++;
      let url = decodeEntities(m2[1]);
      if (url.startsWith("//")) url = "https:" + url;
      const unwrapped = ddgRedirectTarget(url);
      if (unwrapped) url = unwrapped;
      if (!/^https?:\/\//i.test(url) || isAdUrl(url)) continue;
      listings.push({ url, title: stripTags(m2[2]), snippet: s2[i - 1] ?? "", engine: "duckduckgo", scoreHint: Math.max(0.15, 1 - i * 0.04) });
    }
  }
  return {
    listings,
    outcome: { engine: "duckduckgo", ok: listings.length > 0, hits: listings.length, error: listings.length ? undefined : "No parseable results", tookMs: Date.now() - started },
  };
}

async function searchBing(query: string, site?: string): Promise<EngineResult> {
  const started = Date.now();
  const q = site ? `${query} site:${site}` : query;
  const html = await fetchText(`https://www.bing.com/search?q=${encodeURIComponent(q)}&count=20`);
  if (!html) {
    return { listings: [], outcome: { engine: "bing", ok: false, hits: 0, error: "Upstream unreachable", tookMs: Date.now() - started } };
  }
  const listings: WebListing[] = [];
  const re = /<li class="b_algo"[^>]*>[\s\S]*?<h2><a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a><\/h2>([\s\S]*?)(?=<li class="b_algo|$)/gi;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(html)) !== null && i < 20) {
    i++;
    const url = decodeEntities(m[1]);
    const title = stripTags(m[2]);
    if (!/^https?:\/\//i.test(url) || !title) continue;
    const snipMatch = /<p[^>]*>([\s\S]*?)<\/p>/.exec(m[3]);
    listings.push({ url, title, snippet: snipMatch ? truncate(stripTags(snipMatch[1]), 300) : "", engine: "bing", scoreHint: Math.max(0.15, 1 - i * 0.05) });
  }
  return {
    listings,
    outcome: { engine: "bing", ok: listings.length > 0, hits: listings.length, error: listings.length ? undefined : "No parseable results", tookMs: Date.now() - started },
  };
}

async function searchWikipedia(query: string, site?: string): Promise<EngineResult> {
  const started = Date.now();
  if (site && !/wikipedia\.org$/i.test(site)) {
    return { listings: [], outcome: { engine: "wikipedia", ok: false, hits: 0, error: "Skipped (not a wikipedia.org site)", tookMs: 0 } };
  }
  type MwResponse = { query?: { search?: Array<{ title: string; snippet: string; pageid: number; timestamp?: string }> } };
  const data = await fetchJson<MwResponse>(
    `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&srlimit=12&format=json&origin=*`
  );
  const items = data?.query?.search ?? [];
  const listings: WebListing[] = items.map((it, i) => ({
    url: `https://en.wikipedia.org/wiki/${encodeURIComponent(it.title.replace(/ /g, "_"))}`,
    title: it.title,
    snippet: truncate(stripTags(it.snippet), 300),
    engine: "wikipedia" as const,
    scoreHint: Math.max(0.2, 1 - i * 0.06),
  }));
  return {
    listings,
    outcome: { engine: "wikipedia", ok: listings.length > 0, hits: listings.length, error: listings.length ? undefined : "No results", tookMs: Date.now() - started },
  };
}

async function searchHackerNews(query: string, site?: string): Promise<EngineResult> {
  const started = Date.now();
  if (site && site !== "news.ycombinator.com") {
    return { listings: [], outcome: { engine: "hackernews", ok: false, hits: 0, error: "Skipped (site filter)", tookMs: 0 } };
  }
  type HnResponse = { hits?: Array<{ url?: string; title?: string; objectID: string; points?: number; _tags?: string[] }> };
  const data = await fetchJson<HnResponse>(
    `https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(query)}&hitsPerPage=12`
  );
  const hits = data?.hits ?? [];
  const listings: WebListing[] = hits
    .filter((h) => (h._tags ?? []).includes("story"))
    .map((h, i) => ({
      url: h.url && /^https?:\/\//i.test(h.url) ? h.url : `https://news.ycombinator.com/item?id=${h.objectID}`,
      title: h.title ?? "Hacker News story",
      snippet: `Hacker News discussion (${h.points ?? 0} points)${h.url ? "" : " — self post"}`,
      engine: "hackernews" as const,
      scoreHint: Math.max(0.1, Math.min(1, (h.points ?? 1) / 200) || 1 - i * 0.05),
    }));
  return {
    listings,
    outcome: { engine: "hackernews", ok: listings.length > 0, hits: listings.length, error: listings.length ? undefined : "No results", tookMs: Date.now() - started },
  };
}

async function searchGitHub(query: string, site?: string): Promise<EngineResult> {
  const started = Date.now();
  if (site && site !== "github.com") {
    return { listings: [], outcome: { engine: "github", ok: false, hits: 0, error: "Skipped (site filter)", tookMs: 0 } };
  }
  type GhResponse = { items?: Array<{ html_url: string; full_name: string; description?: string | null; stargazers_count?: number; language?: string | null; updated_at?: string }> };
  const data = await fetchJson<GhResponse>(
    `https://api.github.com/search/repositories?q=${encodeURIComponent(query)}&per_page=10`,
  );
  const items = data?.items ?? [];
  const listings: WebListing[] = items.map((r, i) => ({
    url: r.html_url,
    title: `${r.full_name} — ${r.language ?? "code"}`,
    snippet: truncate(r.description ?? "", 300) + (r.stargazers_count ? ` (★ ${r.stargazers_count.toLocaleString()})` : ""),
    engine: "github" as const,
    scoreHint: Math.max(0.1, 1 - i * 0.07),
  }));
  return {
    listings,
    outcome: { engine: "github", ok: listings.length > 0, hits: listings.length, error: listings.length ? undefined : "No results (or unauthenticated rate limit)", tookMs: Date.now() - started },
  };
}

async function searchReddit(query: string, site?: string): Promise<EngineResult> {
  const started = Date.now();
  if (site && site !== "reddit.com") {
    return { listings: [], outcome: { engine: "reddit", ok: false, hits: 0, error: "Skipped (site filter)", tookMs: 0 } };
  }
  type RdResponse = { data?: { children?: Array<{ data?: { url?: string; title?: string; permalink?: string; subreddit_name_prefixed?: string; selftext?: string; created_utc?: number } }> } };
  const data = await fetchJson<RdResponse>(
    `https://www.reddit.com/search.json?q=${encodeURIComponent(query)}&limit=10&raw_json=1`
  );
  const children = data?.data?.children ?? [];
  const listings: WebListing[] = children
    .map((c) => c.data)
    .filter((d): d is NonNullable<typeof d> => !!d && (!!d.title))
    .map((d, i) => ({
      url: d.permalink ? `https://www.reddit.com${d.permalink}` : (d.url ?? ""),
      title: truncate(d.title ?? "", 200),
      snippet: truncate(d.selftext ?? `Posted in ${d.subreddit_name_prefixed ?? "r/"}`, 300),
      engine: "reddit" as const,
      scoreHint: Math.max(0.1, 1 - i * 0.07),
    }))
    .filter((l) => /^https?:\/\//i.test(l.url));
  return {
    listings,
    outcome: { engine: "reddit", ok: listings.length > 0, hits: listings.length, error: listings.length ? undefined : "No results (endpoint may require auth)", tookMs: Date.now() - started },
  };
}

async function searchStackExchange(query: string, site?: string): Promise<EngineResult> {
  const started = Date.now();
  if (site && !/stackexchange\.com$/i.test(site) && site !== "stackoverflow.com") {
    return { listings: [], outcome: { engine: "stackexchange", ok: false, hits: 0, error: "Skipped (site filter)", tookMs: 0 } };
  }
  type SeResponse = { items?: Array<{ link: string; title: string; score?: number; is_answered?: boolean; tags?: string[] }> };
  const data = await fetchJson<SeResponse>(
    `https://api.stackexchange.com/2.3/search/advanced?order=desc&sort=relevance&q=${encodeURIComponent(query)}&site=stackoverflow&pagesize=10&filter=!nNPvSNdWme`
  );
  const items = data?.items ?? [];
  const listings: WebListing[] = items.map((it, i) => ({
    url: it.link,
    title: decodeEntities(it.title),
    snippet: `Stack Overflow · score ${it.score ?? 0}${it.is_answered ? " · answered" : ""}${(it.tags ?? []).length ? " · " + (it.tags ?? []).slice(0, 4).join(", ") : ""}`,
    engine: "stackexchange" as const,
    scoreHint: Math.max(0.1, 1 - i * 0.07),
  }));
  return {
    listings,
    outcome: { engine: "stackexchange", ok: listings.length > 0, hits: listings.length, error: listings.length ? undefined : "No results", tookMs: Date.now() - started },
  };
}

/* --------------------------- merge / enrich / rank ------------------------- */

export function mergeListings(results: EngineResult[]): WebListing[] {
  const seen = new Map<string, WebListing>();
  for (const r of results) {
    for (const l of r.listings) {
      let canon: string;
      try {
        canon = canonicalizeUrl(l.url);
      } catch {
        continue;
      }
      const existing = seen.get(canon);
      if (!existing) {
        seen.set(canon, { ...l, url: canon });
      } else {
        // keep richer snippet + strongest engine signal
        if (!existing.snippet && l.snippet) existing.snippet = l.snippet;
        existing.scoreHint = Math.max(existing.scoreHint, l.scoreHint);
      }
    }
  }
  return [...seen.values()].sort((a, b) => b.scoreHint - a.scoreHint);
}

async function enrichListings(listings: WebListing[], maxPages: number): Promise<{ docs: SearchDocument[]; enriched: number }> {
  const now = new Date().toISOString();
  const docs: SearchDocument[] = [];
  let enriched = 0;
  const candidates = listings.slice(0, maxPages);
  const settled = await Promise.allSettled(
    candidates.map(async (l) => {
      if (!(await isPublicHttpUrl(l.url))) return null;
      const outcome = await secureFetch(l.url, 8000, MAX_RESPONSE_BYTES);
      if (!outcome.ok || !outcome.html) return null;
      const { extractContent } = await import("@/lib/crawler/content-extractor");
      const e = extractContent(outcome.html, l.url, outcome.finalUrl ?? l.url);
      if (!e.content || e.content.length < 40) return null;
      enriched++;
      const doc: SearchDocument = {
        id: `web_${Math.abs(hashCode(e.canonicalUrl || l.url)).toString(36)}`,
        url: l.url,
        canonicalUrl: e.canonicalUrl || l.url,
        title: e.title || l.title,
        description: e.description || l.snippet,
        content: e.content.slice(0, 120_000),
        headings: e.headings.slice(0, 100),
        keywords: [],
        source: safeHostOf(l.url),
        language: e.language || "en",
        contentHash: "",
        indexedAt: now,
        updatedAt: now,
      };
      return { doc, engine: l.engine };
    })
  );
  const engineByUrl = new Map(settled.flatMap((s) => (s.status === "fulfilled" && s.value ? [[s.value.doc.canonicalUrl, s.value.engine] as const] : [])));
  for (const s of settled) {
    if (s.status === "fulfilled" && s.value) docs.push(s.value.doc);
  }
  // attach engine provenance via map for ranking output
  for (const d of docs) {
    const eng = engineByUrl.get(d.canonicalUrl);
    (d as SearchDocument & { __engine?: WebEngineId }).__engine = eng ?? "duckduckgo";
  }
  return { docs, enriched };
}

function hashCode(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  }
  return h;
}

function safeHostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "web";
  }
}

/* --------------------------------- cache ---------------------------------- */

interface CacheEntry {
  at: number;
  listings: WebListing[];
  outcomes: EngineOutcome[];
}
const CACHE_TTL_MS = 5 * 60 * 1000;
const webCache = new Map<string, CacheEntry>();

function cacheGet(key: string): CacheEntry | null {
  const hit = webCache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > CACHE_TTL_MS) {
    webCache.delete(key);
    return null;
  }
  return hit;
}

function cachePut(key: string, entry: CacheEntry): void {
  if (webCache.size > 200) {
    const oldest = [...webCache.entries()].sort((a, b) => a[1].at - b[1].at)[0];
    if (oldest) webCache.delete(oldest[0]);
  }
  webCache.set(key, entry);
}

/* ------------------------------ main pipeline ------------------------------ */

export interface GlobalSearchOptions extends EngineOptions {
  site?: string;
  enrich?: boolean;
  enrichPages?: number;
  engines?: WebEngineId[];
}

export async function globalWebSearch(
  query: string,
  opts: GlobalSearchOptions = {}
): Promise<GlobalSearchResponse | { error: string }> {
  const startedAt = Date.now();
  const site = opts.site?.trim() || undefined;
  const wantEngines: WebEngineId[] =
    opts.engines && opts.engines.length ? opts.engines : ["duckduckgo", "bing", "wikipedia", "hackernews", "github", "reddit", "stackexchange"];

  const key = `${query.toLowerCase().trim()}::${site ?? "*"}`;
  const cachedEntry = cacheGet(key);
  let listings: WebListing[];
  let outcomes: EngineOutcome[];

  if (cachedEntry) {
    listings = cachedEntry.listings;
    outcomes = cachedEntry.outcomes;
  } else {
    const runners: Array<Promise<EngineResult>> = [];
    for (const e of wantEngines) {
      switch (e) {
        case "duckduckgo": runners.push(searchDuckDuckGo(query, site)); break;
        case "bing": runners.push(searchBing(query, site)); break;
        case "wikipedia": runners.push(searchWikipedia(query, site)); break;
        case "hackernews": runners.push(searchHackerNews(query, site)); break;
        case "github": runners.push(searchGitHub(query, site)); break;
        case "reddit": runners.push(searchReddit(query, site)); break;
        case "stackexchange": runners.push(searchStackExchange(query, site)); break;
      }
    }
    const settled = await Promise.all(runners.map((p) => p.catch((err): EngineResult => ({
      listings: [],
      outcome: { engine: "duckduckgo", ok: false, hits: 0, error: err instanceof Error ? err.message : String(err), tookMs: 0 },
    }))));
    outcomes = settled.map((s) => s.outcome);
    listings = mergeListings(settled);
    cachePut(key, { at: Date.now(), listings, outcomes });
  }

  if (listings.length === 0) {
    const detail = outcomes.filter((o) => !o.ok).map((o) => `${o.engine}: ${o.error ?? "failed"}`).join("; ");
    return {
      error: `No live results could be retrieved right now.${detail ? ` (${detail})` : ""}`,
    };
  }

  // Domain filter applied over discovered URLs (works for every engine).
  if (opts.domain && !site) {
    const d = opts.domain.toLowerCase().replace(/^www\./, "");
    listings = listings.filter((l) => safeHostOf(l.url).toLowerCase().replace(/^www\./, "").endsWith(d));
    if (listings.length === 0) {
      return { error: `Live results exist, but none matched the domain filter "${opts.domain}".` };
    }
  }

  // Enrich top pages with real fetched content so ranking uses full text.
  let docs: SearchDocument[] = [];
  let enriched = 0;
  const doEnrich = opts.enrich !== false && !cachedEntry;
  if (doEnrich) {
    const r = await enrichListings(listings, Math.max(0, Math.min(opts.enrichPages ?? 6, 10)));
    docs = r.docs;
    enriched = r.enriched;
  }

  // Corpus for ranking: enriched full-text docs + snippet-only docs for the rest.
  const now = new Date().toISOString();
  const enrichedUrls = new Set(docs.map((d) => d.canonicalUrl));
  const snippetDocs: SearchDocument[] = listings
    .filter((l) => !enrichedUrls.has(l.url))
    .map((l) => ({
      id: `web_${Math.abs(hashCode(l.url)).toString(36)}`,
      url: l.url,
      canonicalUrl: l.url,
      title: l.title,
      description: l.snippet,
      content: `${l.title}\n${l.snippet}`,
      headings: [l.title],
      keywords: [],
      source: safeHostOf(l.url),
      language: "en",
      contentHash: "",
      indexedAt: now,
      updatedAt: now,
    }));
  for (let i = 0; i < snippetDocs.length; i++) {
    (snippetDocs[i] as SearchDocument & { __engine?: WebEngineId }).__engine = listings.find((l) => l.url === snippetDocs[i].url)?.engine ?? "duckduckgo";
  }

  const allDocs = [...docs, ...snippetDocs];
  const corpus = allDocs.map((d) => ({
    id: d.id,
    url: d.url,
    canonicalUrl: d.canonicalUrl,
    title: d.title,
    description: d.description,
    content: d.content,
    headings: d.headings,
    keywords: d.keywords,
    source: d.source,
    language: d.language,
    indexedAt: d.indexedAt,
    updatedAt: d.updatedAt,
  }));

  const bundle = serverSearchBundle(query, corpus, { ...opts, limit: opts.limit ?? 20 });
  const engineById = new Map<string, WebEngineId>(
    allDocs.map((d) => [d.id, (d as SearchDocument & { __engine?: WebEngineId }).__engine ?? "duckduckgo"])
  );

  const results = bundle.response.results.map((r) => ({
    ...r,
    engine: engineById.get(r.id) ?? "duckduckgo",
  }));

  return {
    ...bundle.response,
    results,
    scope: site ? "site-web" : "global-web",
    tookMs: Date.now() - startedAt,
    engines: outcomes,
    retrieved: listings.length,
    enriched,
    cached: !!cachedEntry,
    site: site ?? null,
    providerErrors: outcomes.filter((o) => !o.ok).map((o) => `${o.engine}: ${o.error ?? "failed"}`),
  };
}
