/**
 * GET|POST /api/v1/search/global — the internet search endpoint.
 *
 * This is TixlogicSearch's global web search: it queries multiple public
 * live-internet sources in parallel (DuckDuckGo, Bing, Wikipedia, Hacker News,
 * GitHub, Reddit, Stack Exchange), merges + deduplicates the discovered URLs,
 * optionally fetches the top pages for full-text ranking (SSRF-hardened,
 * robots.txt-respecting) and ranks everything with the same BM25/TF-IDF engine
 * used by the rest of the product.
 *
 * Designed for programmatic use by other tools (a search tool API, not a
 * browser automation):
 *   curl 'http://host/api/v1/search/global?q=quantum+computing&limit=10'
 *   curl -X POST http://host/api/v1/search/global \
 *        -H 'content-type: application/json' \
 *        -d '{"q":"next.js router","site":"github.com","format":"json"}'
 * Supports ?format=json|xml|csv|markdown|text|html|ndjson and CORS.
 */

import type { NextRequest } from "next/server";
import { z } from "zod";
import { optionsResponse } from "@/lib/security/api-helpers";
import { applyIpRateLimit, fail, makeCtx, parseBody } from "@/lib/api/route-helpers";
import { globalWebSearch } from "@/lib/search/global-web";
import { serializeSearchResponse } from "@/lib/validation/serializers";
import type { WebEngineId } from "@/types";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const ENGINE_IDS: readonly WebEngineId[] = [
  "duckduckgo",
  "bing",
  "wikipedia",
  "hackernews",
  "github",
  "reddit",
  "stackexchange",
] as const;

const bodySchema = z.object({
  q: z.string().trim().min(1).max(512).optional(),
  query: z.string().trim().min(1).max(512).optional(),
  site: z.string().trim().max(253).optional(),
  domain: z.string().trim().max(253).optional(),
  limit: z.coerce.number().int().min(1).max(50).optional().default(10),
  page: z.coerce.number().int().min(1).max(1000).optional().default(1),
  enrich: z.boolean().optional().default(true),
  enrichPages: z.coerce.number().int().min(0).max(10).optional().default(6),
  engines: z
    .array(z.enum(["duckduckgo", "bing", "wikipedia", "hackernews", "github", "reddit", "stackexchange"]))
    .max(7)
    .optional(),
  algorithm: z.enum(["bm25", "tfidf"]).optional(),
  sort: z.enum(["relevance", "date", "title"]).optional().default("relevance"),
  format: z.enum(["json", "xml", "csv", "markdown", "text", "html", "ndjson"]).optional(),
});

type BodyInput = z.infer<typeof bodySchema>;

function parseCsvEngines(raw: string | null): WebEngineId[] | undefined {
  if (!raw) return undefined;
  const list = raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s): s is WebEngineId => (ENGINE_IDS as readonly string[]).includes(s));
  return list.length ? list : undefined;
}

function coerceBool(v: FormDataEntryValue | string | null): boolean | undefined {
  if (v === null || v === undefined || v === "") return undefined;
  const s = String(v).toLowerCase();
  if (["1", "true", "yes", "on"].includes(s)) return true;
  if (["0", "false", "no", "off"].includes(s)) return false;
  return undefined;
}

function pick(fd: FormData, ...keys: string[]): string | undefined {
  for (const k of keys) {
    const v = fd.get(k);
    if (typeof v === "string" && v.trim()) return v;
  }
  return undefined;
}

async function run(ctx: ReturnType<typeof makeCtx>, req: NextRequest) {
  const rl = applyIpRateLimit(ctx, req);
  if (rl) return rl;

  let input: BodyInput;
  if (req.method === "GET") {
    const sp = req.nextUrl.searchParams;
    const parsed = bodySchema.safeParse({
      q: sp.get("q") ?? sp.get("query"),
      site: sp.get("site") ?? undefined,
      domain: sp.get("domain") ?? undefined,
      limit: sp.get("limit") ?? undefined,
      page: sp.get("page") ?? undefined,
      enrich: coerceBool(sp.get("enrich")),
      enrichPages: sp.get("enrichPages") ?? undefined,
      engines: parseCsvEngines(sp.get("engines")),
      algorithm: sp.get("algorithm") ?? undefined,
      sort: sp.get("sort") ?? undefined,
      format: sp.get("format") ?? undefined,
    });
    if (!parsed.success) {
      return fail(422, "VALIDATION_FAILED", "Invalid query parameters.", ctx, parsed.error.flatten());
    }
    input = parsed.data;
  } else {
    const ct = (req.headers.get("content-type") || "").toLowerCase();
    if (ct.includes("application/x-www-form-urlencoded")) {
      const fd = await req.formData().catch(() => new FormData());
      const parsed = bodySchema.safeParse({
        q: pick(fd, "q", "query"),
        site: pick(fd, "site"),
        domain: pick(fd, "domain"),
        limit: pick(fd, "limit"),
        page: pick(fd, "page"),
        enrich: coerceBool(fd.get("enrich")),
        enrichPages: pick(fd, "enrichPages"),
        engines: parseCsvEngines(pick(fd, "engines") ?? null),
        algorithm: pick(fd, "algorithm"),
        sort: pick(fd, "sort"),
        format: pick(fd, "format"),
      });
      if (!parsed.success) {
        return fail(422, "VALIDATION_FAILED", "Invalid form fields.", ctx, parsed.error.flatten());
      }
      input = parsed.data;
    } else {
      const parsed = await parseBody(bodySchema, req, ctx);
      if (!parsed.ok) return parsed.response;
      input = parsed.data;
    }
  }

  const query = (input.q ?? input.query ?? "").trim();
  if (!query) {
    return fail(422, "VALIDATION_FAILED", "Provide `q` (or `query`) with the text to search on the internet.", ctx);
  }

  try {
    const result = await globalWebSearch(query, {
      site: input.site,
      domain: input.domain,
      limit: input.limit,
      page: input.page,
      sort: input.sort,
      algorithm: input.algorithm,
      enrich: input.enrich,
      enrichPages: input.enrichPages,
      engines: input.engines,
    });
    if ("error" in result) {
      return fail(502, "RETRIEVAL_FAILED", result.error, ctx);
    }
    const format = input.format ?? ctx.format;
    const serialized = serializeSearchResponse(result, format);
    return new Response(serialized.body, {
      status: 200,
      headers: {
        "Content-Type": serialized.contentType,
        "X-Request-Id": ctx.rid,
        "X-Search-Retrieved": String(result.retrieved),
        "X-Search-Enriched": String(result.enriched),
        "X-Search-Cached": String(result.cached),
      },
    });
  } catch (e) {
    return fail(500, "INTERNAL_ERROR", "Global search failed unexpectedly.", ctx, process.env.NODE_ENV === "development" ? String(e) : undefined);
  }
}

export function OPTIONS(req: NextRequest) {
  return optionsResponse(req);
}

export async function GET(req: NextRequest) {
  return run(makeCtx(req), req);
}

export async function POST(req: NextRequest) {
  return run(makeCtx(req), req);
}
