/**
 * TixlogicSearch — shared type definitions.
 * Used by both client (IndexedDB services) and server (API route handlers).
 */

export type Role = "MASTER_ADMIN" | "ADMIN" | "INTEGRATION_CLIENT" | "USER";

export interface SearchDocument {
  id: string;
  url: string;
  canonicalUrl: string;
  title: string;
  description: string;
  content: string;
  headings: string[];
  keywords: string[];
  source: string; // origin host or "manual"
  language: string;
  contentHash: string;
  indexedAt: string; // ISO
  updatedAt: string; // ISO
}

export interface InvertedIndexEntry {
  term: string;
  documentIds: string[];
  termFrequencies: Record<string, number>;
  positions: Record<string, number[]>;
}

export interface SearchHistoryItem {
  id: string;
  query: string;
  timestamp: string;
  resultCount: number;
}

export interface CachedResult {
  id: string;
  queryHash: string;
  results: SearchResult[];
  createdAt: string;
  expiresAt: string;
}

export interface SavedSearch {
  id: string;
  name: string;
  query: string;
  createdAt: string;
}

export type IntegrationStatus = "active" | "revoked";
export type IntegrationPermission =
  | "search:read"
  | "ai:search"
  | "documents:read"
  | "documents:write"
  | "crawl:submit"
  | "export:data"
  | "index:manage"
  | "usage:read";

export const ALL_PERMISSIONS: IntegrationPermission[] = [
  "search:read",
  "ai:search",
  "documents:read",
  "documents:write",
  "crawl:submit",
  "export:data",
  "index:manage",
  "usage:read",
];

export interface IntegrationRecord {
  id: string;
  name: string;
  permissions: IntegrationPermission[];
  createdAt: string;
  status: IntegrationStatus;
  rateLimitPerMinute: number;
  tokenPrefix: string;
  tokenHash: string;
  lastRotatedAt?: string;
}

export interface SettingsEntry {
  key: string;
  value: unknown;
}

export interface LocalLogEntry {
  id: string;
  event: string;
  timestamp: string;
  details: string;
}

export interface CrawlJobRecord {
  id: string;
  url: string;
  status: "pending" | "running" | "completed" | "failed" | "cancelled";
  maxPages: number;
  depth: number;
  sameDomainOnly: boolean;
  pagesRetrieved: number;
  pagesFailed: number;
  documentsStored: number;
  duplicatesSkipped: number;
  errors: string[];
  startedAt: string;
  finishedAt?: string;
}

/* ------------------------- search & ranking ------------------------- */

export type RankingAlgorithm = "bm25" | "tfidf";

export interface RankWeights {
  bm25: number;
  tfidf: number;
  title: number;
  headings: number;
  phrase: number;
  keywords: number;
  freshness: number;
}

export const DEFAULT_RANK_WEIGHTS: RankWeights = {
  bm25: 1.0,
  tfidf: 0.25,
  title: 0.6,
  headings: 0.35,
  phrase: 0.8,
  keywords: 0.4,
  freshness: 0.15,
};

export interface SearchQueryInput {
  query: string;
  limit?: number;
  page?: number;
  domain?: string;
  algorithm?: RankingAlgorithm;
  sort?: "relevance" | "date" | "title";
}

export interface SearchResult {
  id: string;
  url: string;
  canonicalUrl: string;
  title: string;
  description: string;
  source: string;
  language: string;
  indexedAt: string;
  updatedAt: string;
  score: number;
  matchedTerms: string[];
  snippet: string;
  contentAvailable: boolean;
  duplicateOf?: string | null;
}

export interface SearchPagination {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
  hasNext: boolean;
  hasPrev: boolean;
}

export interface SearchResponse {
  query: string;
  normalizedQuery: string;
  tokens: string[];
  results: SearchResult[];
  pagination: SearchPagination;
  tookMs: number;
  indexSize: number;
  scope: "local-index" | "live-web" | "global-web" | "site-web" | "submitted-corpus";
}

/* --------------------------- global web search --------------------------- */

/** A single upstream discovery source (public search APIs / HTML endpoints). */
export type WebEngineId =
  | "duckduckgo"
  | "wikipedia"
  | "hackernews"
  | "github"
  | "reddit"
  | "stackexchange"
  | "bing";

export interface EngineOutcome {
  engine: WebEngineId;
  ok: boolean;
  error?: string;
  hits: number;
  tookMs: number;
}

/** One discovered web listing (URL + title + snippet) from a live source. */
export interface WebListing {
  url: string;
  title: string;
  snippet: string;
  engine: WebEngineId;
  scoreHint: number; // upstream rank signal (0..1), informational only
}

export interface GlobalSearchResult extends SearchResult {
  engine: WebEngineId;
}

export interface GlobalSearchResponse extends Omit<SearchResponse, "results"> {
  results: GlobalSearchResult[];
  engines: EngineOutcome[];
  retrieved: number;
  enriched: number;
  cached: boolean;
  site: string | null;
  providerErrors: string[];
}

/* ----------------------------- crawler ------------------------------ */

export interface ExtractedContent {
  url: string;
  finalUrl: string;
  canonicalUrl: string;
  title: string;
  description: string;
  headings: string[];
  content: string;
  language: string;
  links: string[];
  contentType: string;
  truncated: boolean;
  partial: boolean;
}

export interface CrawlConfig {
  maxPages: number;
  depth: number;
  sameDomainOnly: boolean;
  timeoutMs: number;
  maxResponseBytes: number;
  delayMs: number;
}

export const DEFAULT_CRAWL_CONFIG: CrawlConfig = {
  maxPages: 10,
  depth: 1,
  sameDomainOnly: true,
  timeoutMs: 15000,
  maxResponseBytes: 512 * 1024,
  delayMs: 500,
};

export interface CrawlPageResult {
  url: string;
  status: "stored" | "duplicate" | "failed" | "skipped";
  reason?: string;
  documentId?: string;
  /** Extracted page data returned by the crawl API so the browser can persist it into IndexedDB. */
  documentPayload?: {
    url: string;
    canonicalUrl: string;
    title: string;
    description: string;
    content: string;
    headings: string[];
    keywords: string[];
    language: string;
    source: string;
  };
}

export interface CrawlResponse {
  jobId: string;
  rootUrl: string;
  status: "completed" | "partial" | "failed";
  pagesVisited: number;
  pagesStored: number;
  pagesDuplicate: number;
  pagesFailed: number;
  pageResults: CrawlPageResult[];
  robotsNoticed: boolean;
  errors: string[];
  tookMs: number;
}

/* -------------------------------- AI -------------------------------- */

export interface AiSourceCitation {
  title: string;
  url: string;
  note?: string;
}

export interface AiSearchResponse {
  query: string;
  answer: string;
  grounded: boolean;
  citations: AiSourceCitation[];
  results: SearchResult[];
  unavailableReason: string | null;
  model: string;
  provider: string;
  usedFallback: boolean;
  tookMs: number;
}

/* ------------------------------- auth ------------------------------- */

export interface AuthUserSummary {
  username: string;
  role: Role;
}

export interface SessionInfo {
  sessionId: string;
  userId: string;
  username: string;
  role: Role;
  expiresAt: number;
}

/* ------------------------------- API -------------------------------- */

export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    requestId: string;
    details?: unknown;
  };
}

export type OutputFormat =
  | "json"
  | "xml"
  | "csv"
  | "markdown"
  | "text"
  | "html"
  | "ndjson";

export interface HealthResponse {
  status: "ok" | "degraded";
  service: string;
  version: string;
  time: string;
  aiConfigured: boolean;
  stores: string[];
  notes: string[];
}
