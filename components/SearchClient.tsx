"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import {
  Search, Sparkles, X, History as HistoryIcon, Bookmark, ChevronLeft,
  ChevronRight, ExternalLink, Clock, Ban, FileText, Database, ListTree, Zap,
} from "lucide-react";
import { localSearch } from "@/services/local-search-service";
import { webRetrieve } from "@/services/client-services";
import { useAppState } from "@/components/AppProviders";
import { useDebouncedValue } from "@/hooks/useDebounced";
import { Badge, Button, Card, EmptyState, ErrorNote, InfoNote, Input, Select, Spinner } from "@/components/ui";
import type { AiSearchResponse, SavedSearch, SearchHistoryItem, SearchResponse } from "@/types";

type Mode = "global" | "local" | "website" | "ai";

const MODES: Array<{ id: Mode; label: string; hint: string }> = [
  { id: "global", label: "Global web", hint: "Search the live internet through multiple public engines (DuckDuckGo, Bing, Wikipedia, HN, GitHub, Reddit, Stack Exchange), ranked by our BM25/TF-IDF engine." },
  { id: "local", label: "My index", hint: "Search documents stored in this browser (IndexedDB)." },
  { id: "website", label: "One site", hint: "Retrieve and search pages of a single website via the secure crawler." },
  { id: "ai", label: "AI answer", hint: "Grounded AI summary over retrieved sources (requires OPENROUTER_API_KEY)." },
];

export function SearchClient() {
  const sp = useSearchParams();
  const { ready, storageError, bump } = useAppState();

  const [query, setQuery] = useState(sp.get("q") ?? "");
  const [mode, setMode] = useState<Mode>((sp.get("mode") as Mode) || "global");
  const [domain, setDomain] = useState(sp.get("domain") ?? "");
  const [sort, setSort] = useState<"relevance" | "date" | "title">("relevance");
  const [algorithm, setAlgorithm] = useState<"bm25" | "tfidf">(localSearch.getSettingsSync().algorithm);
  const [limit, setLimit] = useState(10);

  const [loading, setLoading] = useState(false);
  const [response, setResponse] = useState<SearchResponse | null>(null);
  const [globalMeta, setGlobalMeta] = useState<{ engines: Array<{ engine: string; ok: boolean; hits: number; error?: string; tookMs: number }>; retrieved: number; enriched: number; cached: boolean } | null>(null);
  const [ai, setAi] = useState<AiSearchResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [page, setPage] = useState(1);

  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [showSug, setShowSug] = useState(false);
  const [history, setHistory] = useState<SearchHistoryItem[]>([]);
  const [saved, setSaved] = useState<SavedSearch[]>([]);
  const debouncedQ = useDebouncedValue(query, 250);
  const abortRef = useRef<AbortController | null>(null);

  // keep URL in sync (shareable/bookmarkable searches)
  useEffect(() => {
    const url = new URL(window.location.href);
    if (query.trim()) url.searchParams.set("q", query.trim());
    else url.searchParams.delete("q");
    url.searchParams.set("mode", mode);
    if (domain.trim()) url.searchParams.set("domain", domain.trim());
    else url.searchParams.delete("domain");
    window.history.replaceState(null, "", url.toString());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

  useEffect(() => {
    const q = sp.get("q") ?? "";
    const d = sp.get("domain") ?? "";
    const m = (sp.get("mode") as Mode) || "local";
    setQuery(q);
    setDomain(d);
    setMode(m);
    if (q.trim() && ready) void runSearch(q, m, d, 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sp, ready]);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const [h, s] = await Promise.all([localSearch.getHistory(8), listSaved()]);
        if (alive) { setHistory(h); setSaved(s); }
      } catch { /* storage unavailable */ }
    })();
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, response]);

  // suggestions
  useEffect(() => {
    const p = debouncedQ.trim();
    if (!p || p === (sp.get("q") ?? "")) { setSuggestions([]); return; }
    let alive = true;
    localSearch.suggestions(p).then((s) => alive && setSuggestions(s)).catch(() => undefined);
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedQ]);

  async function listSaved(): Promise<SavedSearch[]> {
    const { savedStore } = await import("@/lib/storage/idb");
    const all = await savedStore.all();
    return all.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  }

  const runSearch = useCallback(async (q: string, m: Mode, dom: string, p: number) => {
    if (!q.trim() || !ready) return;
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    setLoading(true);
    setError(null);
    setNotice(null);
    setAi(null);
    setGlobalMeta(null);
    setPage(p);
    setShowSug(false);
    try {
      if (m === "global") {
        const params = new URLSearchParams({ q: q, limit: String(Math.max(limit, 10)), page: String(p), enrich: "true" });
        if (dom.trim()) params.set("site", dom.trim());
        if (algorithm) params.set("algorithm", algorithm);
        if (sort !== "relevance") params.set("sort", sort);
        const res = await fetch(`/api/v1/search/global?${params.toString()}`, { signal: ac.signal });
        const data = await res.json();
        if (!res.ok) {
          throw new Error(data?.error?.message ?? `Global search failed (HTTP ${res.status}).`);
        }
        if (!ac.signal.aborted) {
          setResponse(data as SearchResponse);
          setGlobalMeta({ engines: data.engines ?? [], retrieved: data.retrieved ?? 0, enriched: data.enriched ?? 0, cached: !!data.cached });
        }
      } else if (m === "local") {
        const res = await localSearch.search(q, { domain: dom || undefined, page: p, limit, sort, algorithm });
        if (!ac.signal.aborted) setResponse(res);
      } else if (m === "website") {
        // Website search: ensure the site is retrieved, then search its pages locally.
        const host = dom || guessHost(q);
        if (!host) {
          setError('Website mode needs a site. Enter one in the domain filter or add "site:example.com" to your query.');
          setLoading(false);
          return;
        }
        setNotice(`Checking indexed coverage of ${host}…`);
        const pre = await localSearch.search(q, { domain: host, limit: 1 });
        if (pre.pagination.total === 0) {
          setNotice(`Retrieving accessible pages from ${host}…`);
          const r = await webRetrieve.retrieveUrl(host.startsWith("http") ? host : `https://${host}`, { maxPages: 8, depth: 1 });
          setNotice(`Retrieved ${r.documents} new page(s) from ${host}${r.errors.length ? ` (${r.errors.length} issue(s))` : ""}. Searching…`);
          bump();
        } else {
          setNotice(`Searching already-indexed pages of ${host}. Re-run retrieval from the dashboard Crawler to refresh.`);
        }
        const res = await localSearch.search(q, { domain: host, page: p, limit, sort, algorithm });
        if (!ac.signal.aborted) {
          setResponse(res);
          setDomain(host);
        }
      } else {
        // AI mode — server-grounded answer over local corpus
        const res = await localSearch.search(q, { domain: dom || undefined, limit: 8, sort, algorithm });
        setResponse(res);
        setNotice("Asking the AI to summarize grounded in your indexed sources…");
        const aiRes = await fetch("/api/v1/search/ai", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            query: q,
            mode: dom ? "website" : "auto",
            site: dom || undefined,
            corpus: res.results.slice(0, 6).map((r) => ({ title: r.title, url: r.url, snippet: r.snippet })),
          }),
          signal: ac.signal,
        }).catch(() => null);
        if (!aiRes) throw new Error("AI request could not be delivered.");
        const data = (await aiRes.json()) as AiSearchResponse & { error?: { message: string } };
        if (!aiRes.ok) {
          const msg = data?.error?.message ?? `AI search failed (HTTP ${aiRes.status}).`;
          setError(msg + " Falling back to plain keyword results below.");
        } else {
          setAi(data);
        }
        await localSearch.log("ai.request", `${q} → HTTP ${aiRes.status}`);
      }
      await localSearch.log("search.executed", `[${m}] ${q}`);
    } catch (e) {
      if ((e as Error).name !== "AbortError") {
        setError(e instanceof Error ? e.message : String(e));
      }
    } finally {
      if (!ac.signal.aborted) setLoading(false);
    }
  }, [ready, limit, sort, algorithm, bump]);

  const submit = () => void runSearch(query, mode, domain, 1);

  const cancel = () => {
    abortRef.current?.abort();
    setLoading(false);
    setNotice(null);
  };

  const saveCurrent = async () => {
    if (!query.trim()) return;
    const { savedStore } = await import("@/lib/storage/idb");
    const name = window.prompt("Name this saved search:", query.trim());
    if (!name) return;
    await savedStore.put({ id: `sav_${Date.now().toString(36)}`, name, query: query.trim(), createdAt: new Date().toISOString() });
    setSaved(await listSaved());
    setNotice("Saved.");
  };

  const removeSaved = async (id: string) => {
    const { savedStore } = await import("@/lib/storage/idb");
    await savedStore.remove(id);
    setSaved(await listSaved());
  };

  const clearHistory = async () => {
    await localSearch.clearHistory();
    setHistory([]);
  };

  return (
    <div className="mx-auto max-w-4xl px-4 py-8 space-y-6">
      {/* Search bar */}
      <Card className="relative">
        <div className="flex flex-col sm:flex-row gap-2">
          <div className="relative flex-1">
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onFocus={() => setShowSug(suggestions.length > 0)}
              onBlur={() => setTimeout(() => setShowSug(false), 150)}
              onKeyDown={(e) => e.key === "Enter" && submit()}
              placeholder='Search… use "exact phrases", site:example.com terms'
              aria-label="Search query"
            />
            {showSug && suggestions.length > 0 && (
              <ul className="absolute z-20 mt-1 w-full rounded-lg border border-line bg-background shadow-lg overflow-hidden" role="listbox">
                {suggestions.map((s) => (
                  <li key={s}>
                    <button
                      className="w-full text-left px-3 py-2 text-sm hover:bg-cobalt-soft flex items-center gap-2"
                      onMouseDown={() => { setQuery(s); setShowSug(false); void runSearch(s, mode, domain, 1); }}
                    >
                      <Search size={13} className="text-muted" /> {s}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <Select value={mode} onChange={(e) => setMode(e.target.value as Mode)} aria-label="Search mode" className="sm:w-44">
            {MODES.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
          </Select>
          {loading ? (
            <Button variant="secondary" onClick={cancel}><Ban size={14} /> Cancel</Button>
          ) : (
            <Button onClick={submit}><Search size={14} /> Search</Button>
          )}
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
          <span className="text-muted">Filters:</span>
          <Input
            value={domain}
            onChange={(e) => setDomain(e.target.value)}
            placeholder="domain filter (example.com)"
            className="!w-48 !py-1"
            aria-label="Domain filter"
          />
          <Select value={sort} onChange={(e) => setSort(e.target.value as never)} className="!py-1" aria-label="Sort by">
            <option value="relevance">Relevance</option>
            <option value="date">Newest indexed</option>
            <option value="title">Title A–Z</option>
          </Select>
          <Select value={algorithm} onChange={(e) => setAlgorithm(e.target.value as never)} className="!py-1" aria-label="Ranking algorithm">
            <option value="bm25">BM25</option>
            <option value="tfidf">TF-IDF</option>
          </Select>
          <Select value={limit} onChange={(e) => setLimit(Number(e.target.value))} className="!py-1" aria-label="Results per page">
            {[10, 20, 50].map((n) => <option key={n} value={n}>{n}/page</option>)}
          </Select>
          <button onClick={saveCurrent} className="ml-auto inline-flex items-center gap-1 text-cobalt hover:underline" title="Save this search">
            <Bookmark size={13} /> Save
          </button>
        </div>

        <p className="mt-2 text-xs text-muted">{MODES.find((m) => m.id === mode)?.hint}</p>
        {mode === "ai" && (
          <p className="mt-1 text-xs text-muted">
            AI answers are grounded only in actually indexed content; if the provider is unconfigured you will see a clear notice and normal results.
          </p>
        )}
        {mode === "website" && (
          <p className="mt-2 text-xs text-muted">
            Website mode retrieves accessible pages of one site via the secure crawler (bounded pages, robots.txt honored), stores them in your local index, then ranks matches. Only selected pages are retrieved — not entire websites.
          </p>
        )}
      </Card>

      {storageError && <ErrorNote message={`IndexedDB unavailable: ${storageError}`} />}
      {error && <ErrorNote message={error} />}
      {notice && <InfoNote>{notice}</InfoNote>}

      {/* AI answer card */}
      {ai && (
        <Card className="border-cobalt/40">
          <div className="flex items-center justify-between mb-2">
            <h2 className="text-sm font-semibold flex items-center gap-2">
              <Sparkles size={15} className="text-cobalt" /> AI summary{" "}
              <span className="text-xs font-normal text-muted">(generated — verify with sources)</span>
            </h2>
            <Badge tone={ai.grounded ? "green" : "amber"}>{ai.grounded ? "grounded" : "partially grounded"}</Badge>
          </div>
          <p className="text-sm leading-relaxed whitespace-pre-wrap">{ai.answer}</p>
          {ai.citations.length > 0 && (
            <div className="mt-3">
              <p className="text-xs font-medium text-muted mb-1">Sources used ({ai.citations.length})</p>
              <ol className="list-decimal ml-5 space-y-1">
                {ai.citations.map((c, i) => (
                  <li key={i} className="text-xs">
                    <a href={safe(c.url)} target="_blank" rel="noopener noreferrer nofollow" className="text-cobalt hover:underline">
                      {c.title || c.url}
                    </a>
                    {c.note ? <span className="text-muted"> — {c.note}</span> : null}
                  </li>
                ))}
              </ol>
            </div>
          )}
          {ai.unavailableReason && <p className="mt-2 text-xs text-amber-600">{ai.unavailableReason}</p>}
          {ai.usedFallback && <p className="mt-2 text-xs text-muted">Provider unavailable — showing extracted source excerpts instead.</p>}
        </Card>
      )}

      {/* Engine status strip (global mode) */}
      {globalMeta && (
        <Card className="py-3">
          <div className="flex flex-wrap items-center gap-2 text-[11px]">
            <span className="font-medium text-muted">Live sources:</span>
            {globalMeta.engines.map((e) => (
              <Badge key={e.engine} tone={e.ok ? "green" : "amber"} title={e.error ?? undefined}>
                {e.engine} {e.ok ? `· ${e.hits}` : "· unavailable"}
              </Badge>
            ))}
            <span className="ml-auto text-muted">
              {globalMeta.retrieved} unique URLs discovered · {globalMeta.enriched} pages fully retrieved{globalMeta.cached ? " · served from cache" : ""}
            </span>
          </div>
        </Card>
      )}

      {/* Results */}
      {loading && !response && <div className="flex justify-center py-10"><Spinner label={mode === "global" ? "Searching the live web…" : "Searching…"} /></div>}

      {response && (
        <div className="space-y-3">
          <div className="flex items-center justify-between text-xs text-muted">
            <span>
              {response.pagination.total} result(s) for “{response.query}” in {response.tookMs}ms · scope: {response.scope} · index: {response.indexSize} doc(s)
              {response.tokens.length > 0 && <> · terms: {response.tokens.join(", ")}</>}
            </span>
          </div>

          {response.results.length === 0 ? (
            <EmptyState
              icon={<FileText size={28} className="text-muted" />}
              title={mode === "global" ? "No live results matched this query" : "No matching documents in your local index"}
              hint={mode === "global"
                ? "Try different keywords, remove the domain filter, or check the source badges above for engines that were unavailable."
                : "Try fewer words, switch to Global web to search the live internet, or crawl a site from the dashboard."}
            />
          ) : (
            response.results.map((r) => (
              <article key={r.id} className="rounded-xl border border-line bg-surface p-4 hover:border-cobalt/50 transition-colors">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <a
                      href={safe(r.url)}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-base font-medium text-cobalt hover:underline break-words"
                    >
                      {highlight(r.title, r.matchedTerms)}
                    </a>
                    <p className="mt-0.5 flex items-center gap-1 text-xs text-emerald-700 dark:text-emerald-400">
                      {safeHostLabel(r.url)} <ExternalLink size={11} className="inline" />
                    </p>
                  </div>
                  <div className="flex shrink-0 flex-col items-end gap-1">
                    <Badge tone="blue">score {r.score}</Badge>
                    {(r as { engine?: string }).engine ? <Badge tone="gray">{(r as { engine?: string }).engine}</Badge> : null}
                  </div>
                </div>
                <p className="mt-2 text-sm text-foreground/90 leading-relaxed">
                  {highlight(r.snippet || r.description || "(no text preview available)", r.matchedTerms)}
                </p>
                <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted">
                  <span className="inline-flex items-center gap-1"><Clock size={11} /> indexed {new Date(r.indexedAt).toLocaleString()}</span>
                  <span className="inline-flex items-center gap-1"><Database size={11} /> {r.source}</span>
                  <span>{r.contentAvailable ? "full text available" : "metadata only"}</span>
                  {r.duplicateOf ? <Badge tone="amber">duplicate suppressed</Badge> : null}
                  <Link href={`/dashboard/index?doc=${r.id}`} className="text-cobalt hover:underline inline-flex items-center gap-1">
                    <ListTree size={11} /> inspect
                  </Link>
                </div>
                {r.matchedTerms.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-1">
                    {r.matchedTerms.slice(0, 10).map((t) => (
                      <button
                        key={t}
                        onClick={() => { setQuery(t); void runSearch(t, "local", "", 1); }}
                        className="rounded-full bg-cobalt-soft px-2 py-0.5 text-[11px] text-cobalt hover:bg-cobalt hover:text-white"
                      >
                        {t}
                      </button>
                    ))}
                  </div>
                )}
              </article>
            ))
          )}

          {response.pagination.totalPages > 1 && (
            <nav className="flex items-center justify-center gap-2 pt-2" aria-label="Pagination">
              <Button variant="secondary" disabled={!response.pagination.hasPrev} onClick={() => void runSearch(query, mode, domain, page - 1)}>
                <ChevronLeft size={14} /> Prev
              </Button>
              <span className="text-sm text-muted">Page {response.pagination.page} / {response.pagination.totalPages}</span>
              <Button variant="secondary" disabled={!response.pagination.hasNext} onClick={() => void runSearch(query, mode, domain, page + 1)}>
                Next <ChevronRight size={14} />
              </Button>
            </nav>
          )}
        </div>
      )}

      {/* Side panels when idle */}
      {!response && !loading && !storageError && (
        <div className="grid gap-4 md:grid-cols-2">
          <Card>
            <h3 className="text-sm font-semibold flex items-center gap-2 mb-3"><HistoryIcon size={14} className="text-cobalt" /> Recent searches</h3>
            {history.length === 0 ? (
              <p className="text-xs text-muted">Nothing yet — your search history appears here (stored only in this browser).</p>
            ) : (
              <ul className="space-y-1">
                {history.map((h) => (
                  <li key={h.id}>
                    <button
                      onClick={() => { setQuery(h.query); void runSearch(h.query, "local", "", 1); }}
                      className="w-full text-left rounded-lg px-2 py-1.5 text-sm hover:bg-cobalt-soft flex items-center justify-between gap-2"
                    >
                      <span className="truncate">{h.query}</span>
                      <span className="text-[11px] text-muted shrink-0">{h.resultCount} hits · {new Date(h.timestamp).toLocaleTimeString()}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {history.length > 0 && (
              <button onClick={clearHistory} className="mt-3 text-xs text-red-600 hover:underline inline-flex items-center gap-1">
                <X size={11} /> Clear history
              </button>
            )}
          </Card>
          <Card>
            <h3 className="text-sm font-semibold flex items-center gap-2 mb-3"><Bookmark size={14} className="text-cobalt" /> Saved searches</h3>
            {saved.length === 0 ? (
              <p className="text-xs text-muted">Use “Save” above to pin frequent queries.</p>
            ) : (
              <ul className="space-y-1">
                {saved.map((s) => (
                  <li key={s.id} className="flex items-center justify-between gap-2">
                    <button
                      onClick={() => { setQuery(s.query); void runSearch(s.query, "local", "", 1); }}
                      className="flex-1 text-left rounded-lg px-2 py-1.5 text-sm hover:bg-cobalt-soft truncate"
                    >
                      {s.name}
                    </button>
                    <button onClick={() => void removeSaved(s.id)} className="p-1 text-muted hover:text-red-600" aria-label={`Delete saved search ${s.name}`}>
                      <X size={13} />
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <div className="mt-4 text-xs text-muted">
              Nothing indexed yet? <Zap size={11} className="inline" />{" "}
              <Link href="/dashboard/documents" className="text-cobalt hover:underline">Add documents</Link> or{" "}
              <Link href="/dashboard/crawler" className="text-cobalt hover:underline">retrieve a website</Link> to build your index.
            </div>
          </Card>
        </div>
      )}
    </div>
  );
}

function safe(u: string): string {
  try {
    const parsed = new URL(u);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? u : "#";
  } catch {
    return "#";
  }
}

function safeHostLabel(u: string): string {
  try {
    const p = new URL(u);
    return p.hostname + (p.pathname !== "/" ? p.pathname.slice(0, 40) : "");
  } catch {
    return u.slice(0, 60);
  }
}

function guessHost(q: string): string | null {
  const m = q.match(/(?:https?:\/\/|site:\s*)([A-Za-z0-9.-]+\.[A-Za-z]{2,})/i);
  return m ? m[1].toLowerCase() : null;
}

/** Safe highlighting: split on matched terms, render plain text segments (no raw HTML injection). */
function highlight(text: string, terms: string[]) {
  if (!terms.length || !text) return text;
  const escaped = terms.filter(Boolean).map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  if (!escaped.length) return text;
  const re = new RegExp(`(${escaped.join("|")})`, "ig");
  const lower = new Set(terms.map((t) => t.toLowerCase()));
  return text.split(re).map((part, i) =>
    i % 2 === 1 && lower.has(part.toLowerCase()) ? (
      <mark key={i} className="bg-cobalt-soft text-inherit rounded px-0.5">{part}</mark>
    ) : (
      <span key={i}>{part}</span>
    )
  );
}
