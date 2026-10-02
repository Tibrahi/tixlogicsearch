/**
 * Server-side secure web fetch + bounded crawler.
 * SSRF defenses: every URL (including each redirect hop) is validated with DNS
 * resolution before the request is issued; redirects are followed manually so
 * no hop bypasses validation. Responses are size-limited and content-type
 * restricted. robots.txt is fetched and honored for disallowed paths.
 */

import type { CrawlConfig, CrawlPageResult, CrawlResponse, ExtractedContent } from "@/types";
import { DEFAULT_CRAWL_CONFIG } from "@/types";
import { extractContent, extractLinks } from "@/lib/crawler/content-extractor";
import { validateUrlResolved, canonicalizeUrl } from "@/lib/crawler/url-validator";

const USER_AGENT = "TixlogicSearchBot/1.0 (+local research crawler; respects robots.txt)";
const MAX_REDIRECTS = 5;
const ALLOWED_CONTENT_TYPES = ["text/html", "application/xhtml+xml"];

export interface FetchOutcome {
  ok: boolean;
  finalUrl?: string;
  html?: string;
  error?: string;
  status?: number;
  truncated?: boolean;
}

/** Validate then fetch a single page with manual redirect handling. */
export async function secureFetch(url: string, timeoutMs: number, maxBytes: number): Promise<FetchOutcome> {
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const validation = await validateUrlResolved(current);
    if (!validation.ok || !validation.url) {
      return { ok: false, error: validation.error ?? "URL rejected by security policy" };
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(validation.url.toString(), {
        redirect: "manual",
        signal: controller.signal,
        headers: {
          "User-Agent": USER_AGENT,
          Accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5",
          "Accept-Language": "en",
        },
        credentials: "omit",
      });
      // Handle redirects ourselves — never auto-follow unvalidated targets.
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get("location");
        if (!loc) return { ok: false, status: res.status, error: "Redirect without Location header" };
        let next: URL;
        try {
          next = new URL(loc, validation.url);
        } catch {
          return { ok: false, status: res.status, error: "Malformed redirect target" };
        }
        if (next.protocol !== "http:" && next.protocol !== "https:") {
          return { ok: false, status: res.status, error: "Redirect to non-http(s) scheme blocked" };
        }
        current = next.toString();
        continue;
      }
      if (!res.ok) {
        return { ok: false, status: res.status, error: `HTTP ${res.status}` };
      }
      const contentType = (res.headers.get("content-type") || "").toLowerCase();
      if (!ALLOWED_CONTENT_TYPES.some((t) => contentType.includes(t))) {
        return { ok: false, status: res.status, error: `Unsupported content-type: ${contentType.split(";")[0] || "unknown"} (only HTML pages are retrieved)` };
      }
      // Size-limited streaming read.
      const declaredLen = parseInt(res.headers.get("content-length") || "-1", 10);
      if (declaredLen > maxBytes) {
        return { ok: false, status: res.status, error: `Response too large (${declaredLen} bytes > ${maxBytes})` };
      }
      let text = "";
      let truncated = false;
      if (res.body) {
        const reader = res.body.getReader();
        const decoder = new TextDecoder("utf-8", { fatal: false });
        let received = 0;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          received += value.byteLength;
          if (received > maxBytes) {
            truncated = true;
            await reader.cancel().catch(() => undefined);
            break;
          }
          text += decoder.decode(value, { stream: true });
        }
        text += decoder.decode();
      } else {
        text = await res.text();
        if (text.length > maxBytes) {
          text = text.slice(0, maxBytes);
          truncated = true;
        }
      }
      return { ok: true, finalUrl: current, html: text, status: res.status, truncated };
    } catch (e) {
      const msg = e instanceof Error ? (e.name === "AbortError" ? `Request timed out after ${timeoutMs}ms` : e.message) : String(e);
      return { ok: false, error: msg };
    } finally {
      clearTimeout(timer);
    }
  }
  return { ok: false, error: "Too many redirects" };
}

/* -------------------------------- robots -------------------------------- */

interface RobotsRule {
  path: string;
  disallow: boolean;
}

export function parseRobotsTxt(text: string, userAgent: string): { rules: RobotsRule[]; crawlDelayMs: number | null; noticed: boolean } {
  const lines = text.split(/\r?\n/);
  let relevant = false;
  const rules: RobotsRule[] = [];
  let crawlDelay: number | null = null;
  let sawAnyGroup = false;
  const uaLower = userAgent.toLowerCase();
  for (const raw of lines) {
    const line = raw.split("#")[0].trim();
    if (!line) continue;
    const [keyRaw, ...rest] = line.split(":");
    const key = keyRaw.trim().toLowerCase();
    const value = rest.join(":").trim();
    if (key === "user-agent") {
      relevant = value === "*" || uaLower.includes(value.toLowerCase());
      sawAnyGroup = true;
    } else if (relevant) {
      if (key === "disallow" && value) rules.push({ path: value, disallow: true });
      if (key === "allow" && value) rules.push({ path: value, disallow: false });
      if (key === "crawl-delay") {
        const d = parseFloat(value);
        if (Number.isFinite(d)) crawlDelay = Math.min(Math.max(d * 1000, 0), 60_000);
      }
    }
  }
  void sawAnyGroup;
  return { rules, crawlDelayMs: crawlDelay, noticed: true };
}

export function isPathAllowed(rules: RobotsRule[], pathWithQuery: string): boolean {
  let best: { len: number; disallow: boolean } | null = null;
  for (const r of rules) {
    if (pathWithQuery.startsWith(r.path)) {
      if (!best || r.path.length > best.len) best = { len: r.path.length, disallow: r.disallow };
    }
  }
  return best ? !best.disallow : true;
}

async function fetchRobots(rootUrl: string, timeoutMs: number): Promise<{ rules: RobotsRule[]; crawlDelayMs: number | null; exists: boolean }> {
  try {
    const base = new URL(rootUrl);
    const robotsUrl = `${base.protocol}//${base.host}/robots.txt`;
    const outcome = await secureFetch(robotsUrl, Math.min(timeoutMs, 8000), 64 * 1024);
    if (!outcome.ok || !outcome.html) return { rules: [], crawlDelayMs: null, exists: false };
    const parsed = parseRobotsTxt(outcome.html, USER_AGENT);
    return { rules: parsed.rules, crawlDelayMs: parsed.crawlDelayMs, exists: true };
  } catch {
    return { rules: [], crawlDelayMs: null, exists: false };
  }
}

/* ------------------------------- crawling -------------------------------- */

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export interface CrawlCallbacks {
  onPageStored: (extracted: ExtractedContent, duplicate: boolean) => Promise<"stored" | "duplicate" | "failed">;
  shouldCancel?: () => boolean;
}

export interface CrawlOptions extends Partial<CrawlConfig> {
  callbacks: CrawlCallbacks;
}

export async function crawlSite(startUrl: string, options: CrawlOptions): Promise<CrawlResponse> {
  const startedAt = Date.now();
  const config: CrawlConfig = { ...DEFAULT_CRAWL_CONFIG, ...options };
  const jobId = `crl_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
  const results: CrawlPageResult[] = [];
  const errors: string[] = [];
  let stored = 0;
  let duplicates = 0;
  let failed = 0;
  let cancelled = false;

  const startValidation = await validateUrlResolved(startUrl);
  if (!startValidation.ok) {
    return {
      jobId,
      rootUrl: startUrl,
      status: "failed",
      pagesVisited: 0,
      pagesStored: 0,
      pagesDuplicate: 0,
      pagesFailed: 1,
      pageResults: [{ url: startUrl, status: "failed", reason: startValidation.error }],
      robotsNoticed: false,
      errors: [startValidation.error ?? "URL rejected"],
      tookMs: Date.now() - startedAt,
    };
  }

  const robots = await fetchRobots(startUrl, config.timeoutMs);
  const delay = Math.max(config.delayMs, robots.crawlDelayMs ?? 0);

  const startCanonical = canonicalizeUrl(startValidation.url!.toString());
  const queue: Array<{ url: string; depth: number }> = [{ url: startCanonical, depth: 0 }];
  const visited = new Set<string>();

  while (queue.length > 0 && results.length < config.maxPages) {
    if (options.callbacks.shouldCancel?.()) {
      cancelled = true;
      errors.push("Crawl cancelled by user");
      break;
    }
    const item = queue.shift()!;
    if (visited.has(item.url)) continue;
    visited.add(item.url);

    let pathOk = true;
    try {
      const u = new URL(item.url);
      pathOk = isPathAllowed(robots.rules, u.pathname + u.search);
    } catch {
      pathOk = false;
    }
    if (!pathOk) {
      results.push({ url: item.url, status: "skipped", reason: "Disallowed by robots.txt" });
      continue;
    }

    const outcome = await secureFetch(item.url, config.timeoutMs, config.maxResponseBytes);
    if (!outcome.ok || !outcome.html || !outcome.finalUrl) {
      failed++;
      results.push({ url: item.url, status: "failed", reason: outcome.error });
      if (errors.length < 20) errors.push(`${item.url}: ${outcome.error}`);
      if (delay > 0) await sleep(delay);
      continue;
    }

    const extracted = extractContent(outcome.html, item.url, outcome.finalUrl);
    extracted.truncated = extracted.truncated || !!outcome.truncated;
    const payload = {
      url: extracted.url,
      canonicalUrl: extracted.canonicalUrl,
      title: extracted.title,
      description: extracted.description,
      content: extracted.content.slice(0, 200_000),
      headings: extracted.headings.slice(0, 200),
      keywords: [],
      language: extracted.language,
      source: (() => { try { return new URL(extracted.finalUrl || extracted.url).hostname; } catch { return "crawl"; } })(),
    };
    const storeStatus = await options.callbacks.onPageStored(extracted, false);
    if (storeStatus === "stored") {
      stored++;
      results.push({ url: item.url, status: "stored", documentId: extracted.canonicalUrl, documentPayload: payload });
    } else if (storeStatus === "duplicate") {
      duplicates++;
      results.push({ url: item.url, status: "duplicate" });
    } else {
      failed++;
      results.push({ url: item.url, status: "failed", reason: "Storage rejected the document" });
    }

    // Expand frontier within depth & domain limits.
    if (item.depth < config.depth) {
      try {
        const cleanedHtml = outcome.html;
        const links = extractLinks(cleanedHtml, new URL(outcome.finalUrl), 200);
        for (const link of links) {
          const canon = canonicalizeUrl(link);
          if (visited.has(canon)) continue;
          if (config.sameDomainOnly) {
            try {
              const hostA = new URL(canon).hostname.toLowerCase();
              const hostB = new URL(startCanonical).hostname.toLowerCase();
              if (hostA !== hostB) continue;
            } catch {
              continue;
            }
          }
          if (!queue.some((q) => q.url === canon)) queue.push({ url: canon, depth: item.depth + 1 });
        }
      } catch {
        /* extraction of links failed; continue */
      }
    }
    if (delay > 0 && queue.length > 0) await sleep(delay);
  }

  const status: CrawlResponse["status"] = cancelled || failed > 0 ? (stored + duplicates > 0 ? "partial" : "failed") : "completed";
  return {
    jobId,
    rootUrl: startUrl,
    status,
    pagesVisited: visited.size,
    pagesStored: stored,
    pagesDuplicate: duplicates,
    pagesFailed: failed,
    pageResults: results,
    robotsNoticed: robots.exists,
    errors,
    tookMs: Date.now() - startedAt,
  };
}
