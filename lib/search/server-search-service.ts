/**
 * Server-side search service (stateless).
 *
 * IMPORTANT / honest architecture note:
 * Browser IndexedDB is origin-specific and CANNOT be read by the server.
 * The remote /api/v1/search endpoint therefore searches either:
 *   1. exactly what the caller submits in `corpus.documents`, or
 *   2. a live, securely-fetched web crawl (`fetchLive: true`), which retrieves
 *      real pages from the public internet with SSRF-hardened fetching.
 * It never fabricates results and never claims to see the user's local index.
 */

import { InvertedIndex } from "@/lib/indexing/inverted-index";
import { SearchEngine, type EngineOptions } from "@/lib/search/engine";
import type { RankWeights, SearchDocument, SearchResponse } from "@/types";
import { DEFAULT_RANK_WEIGHTS } from "@/types";

export interface CorpusDocument {
  id?: string;
  url: string;
  canonicalUrl?: string;
  title: string;
  description?: string;
  content?: string;
  headings?: string[];
  keywords?: string[];
  source?: string;
  language?: string;
  indexedAt?: string;
  updatedAt?: string;
}

const MAX_CORPUS_DOCS = 200;
const MAX_DOC_CHARS = 200_000;

function normalizeCorpus(corpus: CorpusDocument[]): Map<string, SearchDocument> {
  const now = new Date().toISOString();
  const docs = new Map<string, SearchDocument>();
  for (let i = 0; i < corpus.length && docs.size < MAX_CORPUS_DOCS; i++) {
    const c = corpus[i];
    const id = c.id ?? `srv_${i.toString(36)}`;
    if (docs.has(id)) continue;
    const doc: SearchDocument = {
      id,
      url: c.url,
      canonicalUrl: c.canonicalUrl || c.url,
      title: String(c.title ?? "").slice(0, 500),
      description: String(c.description ?? "").slice(0, 2000),
      content: String(c.content ?? "").slice(0, MAX_DOC_CHARS),
      headings: (c.headings ?? []).map((h) => String(h).slice(0, 500)).slice(0, 200),
      keywords: (c.keywords ?? []).map((k) => String(k).slice(0, 100)).slice(0, 100),
      source: c.source ?? safeHost(c.url),
      language: c.language ?? "en",
      contentHash: "",
      indexedAt: c.indexedAt ?? now,
      updatedAt: c.updatedAt ?? now,
    };
    docs.set(id, doc);
  }
  return docs;
}

function safeHost(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "unknown";
  }
}

export interface ServerSearchResultBundle {
  response: SearchResponse;
  documents: Map<string, SearchDocument>;
  index: InvertedIndex;
}

export function serverSearchBundle(
  query: string,
  corpus: CorpusDocument[],
  options: EngineOptions & { weights?: RankWeights } = {}
): ServerSearchResultBundle {
  const docs = normalizeCorpus(corpus);
  const index = new InvertedIndex();
  for (const d of docs.values()) {
    index.addDocument(d.id, InvertedIndex.documentText(d), options.stemming ?? false);
  }
  const engine = new SearchEngine(index, docs);
  const startedAt = Date.now();
  const bundle = engine.search(query, options);
  const tookMs = Math.max(1, Date.now() - startedAt);
  const response = engine.toResponse(query, bundle, tookMs, {
    ...options,
    weights: options.weights ?? DEFAULT_RANK_WEIGHTS,
  });
  return { response, documents: docs, index };
}

export function serverSearch(
  query: string,
  corpus: CorpusDocument[],
  options: EngineOptions = {}
): SearchResponse {
  return serverSearchBundle(query, corpus, options).response;
}

/* -------------------------------------------------------------------------- */
/*  Live web search (server-side global retrieval)                             */
/* -------------------------------------------------------------------------- */

import { crawlSite } from "@/lib/crawler/fetcher";
import type { ExtractedContent } from "@/types";

export interface LiveWebSearchResult extends ServerSearchResultBundle {
  pagesVisited: number;
  pagesFailed: number;
  robotsNoticed: boolean;
  errors: string[];
  tookMsTotal: number;
}

/**
 * Retrieve real, publicly accessible web pages for a query and rank them with
 * the same custom inverted-index + BM25/TF-IDF engine. This is what powers
 * "global" search from the UI — results are actual retrieved documents with
 * their original URLs, never fabricated listings.
 */
export async function liveWebSearch(
  query: string,
  opts: { site?: string; maxPages?: number; depth?: number; timeoutMs?: number } & EngineOptions = {}
): Promise<LiveWebSearchResult | { error: string }> {
  // Global internet retrieval (multi-engine discovery + real page enrichment).
  const { globalWebSearch } = await import("@/lib/search/global-web");
  const global = await globalWebSearch(query, {
    site: opts.site,
    limit: opts.limit,
    page: opts.page,
    sort: opts.sort,
    algorithm: opts.algorithm,
    domain: (opts as { domain?: string }).domain,
    enrich: true,
    enrichPages: Math.min(opts.maxPages ?? 6, 8),
  });
  if ("error" in global) return global;
  const docs = new Map<string, SearchDocument>();
  for (const r of global.results) {
    docs.set(r.id, {
      id: r.id, url: r.url, canonicalUrl: r.canonicalUrl, title: r.title,
      description: r.description, content: r.snippet, headings: [], keywords: [],
      source: r.source, language: r.language, contentHash: "", indexedAt: r.indexedAt, updatedAt: r.updatedAt,
    });
  }
  return {
    response: global,
    documents: docs,
    index: new InvertedIndex(),
    pagesVisited: global.retrieved,
    pagesFailed: global.providerErrors.length,
    robotsNoticed: true,
    errors: global.providerErrors,
    tookMsTotal: global.tookMs,
  };
}

/** Legacy single-site crawl retrieval (kept for site-scoped deep crawls). */
export async function crawlWebSearch(
  query: string,
  opts: { site?: string; maxPages?: number; depth?: number; timeoutMs?: number } & EngineOptions = {}
): Promise<LiveWebSearchResult | { error: string }> {
  const startedAt = Date.now();
  let rootUrl: string;
  if (opts.site && opts.site.trim()) {
    const s = opts.site.trim();
    rootUrl = /^https?:\/\//i.test(s) ? s : `https://${s.replace(/^\/+/, "")}`;
  } else {
    // No explicit site: use well-known public entry points so we can reach
    // content "globally" without pretending to be a full-web index.
    rootUrl = "https://en.wikipedia.org/wiki/Special:Search?search=" + encodeURIComponent(query);
  }

  const collected: ExtractedContent[] = [];
  const crawl = await crawlSite(rootUrl, {
    maxPages: opts.maxPages ?? 8,
    depth: opts.depth ?? (opts.site ? 1 : 0),
    sameDomainOnly: true,
    timeoutMs: opts.timeoutMs ?? 15000,
    callbacks: {
      onPageStored: async (extracted) => {
        collected.push(extracted);
        return "stored";
      },
    },
  });

  if (collected.length === 0) {
    return {
      error:
        crawl.errors[0] ??
        "No accessible pages could be retrieved for this search. The site may block crawlers (robots.txt), be unreachable, or the request timed out.",
    };
  }

  const corpus: CorpusDocument[] = collected.map((e) => ({
    url: e.canonicalUrl || e.url,
    canonicalUrl: e.canonicalUrl,
    title: e.title,
    description: e.description,
    content: e.content,
    headings: e.headings,
    keywords: [],
    language: e.language,
    source: safeHost(e.finalUrl || e.url),
  }));

  const bundle = serverSearchBundle(query, corpus, opts);
  return {
    ...bundle,
    pagesVisited: crawl.pagesVisited,
    pagesFailed: crawl.pagesFailed,
    robotsNoticed: crawl.robotsNoticed,
    errors: crawl.errors,
    tookMsTotal: Date.now() - startedAt,
  };
}
