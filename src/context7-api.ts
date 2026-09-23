import { type KeyLease, RoundRobinKeyPool } from "./key-pool.js";
import { noteRedirect, parseUrl, recordAttempt, type UpstreamAttempt } from "./telemetry.js";

function headerNumber(headers: Headers, name: string): number | undefined {
  const value = headers.get(name);
  if (value === null || value.trim() === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

const API_BASE_URL = "https://context7.com/api";
const API_TIMEOUT_MS = 60_000;
const DEFAULT_RATE_LIMIT_COOLDOWN_MS = 60_000;
const MAX_RATE_LIMIT_COOLDOWN_MS = 60 * 60_000;

export type SearchResult = {
  id: string;
  title: string;
  description: string;
  totalSnippets?: number;
  trustScore?: number;
  benchmarkScore?: number;
  versions?: string[];
  source?: string;
};

export type SearchResponse = {
  results?: SearchResult[];
  searchFilterApplied?: boolean;
};

export class Context7ApiError extends Error {
  public constructor(
    message: string,
    public readonly status: number,
    public readonly retryAfterMs?: number,
    /** The `error` field of Context7's JSON error body, e.g. `library_not_found`. */
    public readonly code?: string,
    /** The `redirectUrl` field of a `301 library_redirected` body. */
    public readonly redirectUrl?: string,
  ) {
    super(message);
  }

  public get isBlocked(): boolean {
    return this.status === 401 || this.status === 403 || this.status === 429;
  }

  /**
   * Context7 answers a documentation request for a library hidden by the key's
   * teamspace library filters with the same "not found" as an unindexed library,
   * so that 404 is worth one attempt on the other key. Other 404s, such as
   * `no_relevant_snippets` (the library exists but nothing matched the query),
   * would get the same answer from either key.
   */
  public get isNotFound(): boolean {
    return this.status === 404 && (this.code === undefined || this.code === "library_not_found");
  }
}

type ErrorBody = { error?: unknown; message?: unknown; redirectUrl?: unknown };

function parseErrorBody(text: string): ErrorBody {
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed && typeof parsed === "object" ? (parsed as ErrorBody) : {};
  } catch {
    return {};
  }
}

/**
 * The library ID a `301 library_redirected` points to. Context7 sends a bare
 * ID such as `/react/react`; a full URL is reduced to its path. Anything that
 * is not `/owner/project[/...]` is not followed.
 */
export function redirectTarget(redirectUrl: string | undefined): string | undefined {
  if (!redirectUrl) return undefined;
  let path = redirectUrl.trim();
  if (/^https?:\/\//i.test(path)) {
    const url = parseUrl(path);
    if (!url || !/(^|\.)context7\.com$/i.test(url.hostname) || url.search || url.hash) return undefined;
    path = url.pathname;
  }
  const segments = path.replace(/\/+$/, "").split("/").slice(1);
  const valid = path.startsWith("/")
    && segments.length >= 2
    && segments.every((segment) => /^[^/\s?#]+$/.test(segment) && segment !== "." && segment !== "..");
  return valid ? `/${segments.join("/")}` : undefined;
}

/** What query-docs returns when Context7 answers 200 with an empty body. */
export const DOCS_NOT_FOUND = "Documentation not found or not finalized for this library. This might have happened because you used an invalid Context7-compatible library ID.";

export type FetchLike = typeof fetch;

export function parseRetryAfterMs(value: string | null, now: number): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  const date = Date.parse(trimmed);
  return Number.isNaN(date) ? undefined : Math.max(0, date - now);
}

export class Context7ApiClient {
  public constructor(
    private readonly keyPool: RoundRobinKeyPool,
    private readonly fetchImpl: FetchLike = fetch,
    private readonly log: (message: string) => void = (message) => console.error(message),
  ) {}

  public async searchLibraries(query: string, libraryName: string): Promise<SearchResponse> {
    const url = new URL(`${API_BASE_URL}/v2/libs/search`);
    url.searchParams.set("query", query);
    url.searchParams.set("libraryName", libraryName);
    return this.withBalancedKey(async (lease) => JSON.parse(await this.fetchText(url, lease, "search")) as SearchResponse);
  }

  /**
   * Fetches documentation, following one `301 library_redirected` to the
   * library ID Context7 names in `redirectUrl` (it sends no Location header, so
   * fetch cannot follow it), and says so at the top of the result.
   */
  public async fetchLibraryContext(query: string, libraryId: string): Promise<string> {
    try {
      return await this.fetchLibraryContextOnce(query, libraryId);
    } catch (error) {
      const target = error instanceof Context7ApiError && error.status === 301 ? redirectTarget(error.redirectUrl) : undefined;
      if (!target || target === libraryId) throw error;
      this.log(`Context7 library ${libraryId} redirected to ${target}`);
      noteRedirect(target);
      const text = await this.fetchLibraryContextOnce(query, target);
      return `Note: Context7 library ${libraryId} has moved to ${target}; use that ID from now on.\n\n${text}`;
    }
  }

  private async fetchLibraryContextOnce(query: string, libraryId: string): Promise<string> {
    const url = new URL(`${API_BASE_URL}/v2/context`);
    url.searchParams.set("query", query);
    url.searchParams.set("libraryId", libraryId);
    return this.withBalancedKey(async (lease) => {
      const text = await this.fetchText(url, lease, "context");
      return text || DOCS_NOT_FOUND;
    });
  }

  /**
   * Runs the operation on the next key and at most once more on the other key
   * when the first key is blocked or reports "not found".
   */
  private async withBalancedKey<T>(operation: (lease: KeyLease) => Promise<T>): Promise<T> {
    const selected = this.keyPool.next();
    const alternate = this.keyPool.alternate(selected);
    try {
      return await this.attempt(selected, operation);
    } catch (error) {
      if (!(error instanceof Context7ApiError) || !(error.isBlocked || error.isNotFound)) {
        throw error;
      }
      this.log(`Context7 slot ${selected.index} returned ${error.status}; retrying on slot ${alternate.index}`);
      return this.attempt(alternate, operation);
    }
  }

  private async attempt<T>(lease: KeyLease, operation: (lease: KeyLease) => Promise<T>): Promise<T> {
    try {
      return await operation(lease);
    } catch (error) {
      if (error instanceof Context7ApiError && error.status === 429) {
        const cooldown = Math.min(error.retryAfterMs ?? DEFAULT_RATE_LIMIT_COOLDOWN_MS, MAX_RATE_LIMIT_COOLDOWN_MS);
        this.keyPool.coolDown(lease, cooldown);
        this.log(`Context7 slot ${lease.index} rate limited; cooling down for ${Math.ceil(cooldown / 1000)}s`);
      }
      throw error;
    }
  }

  /**
   * One upstream call, body included, so an attempt's duration covers the
   * whole transfer and a body that fails partway is recorded as a failure.
   */
  private async fetchText(url: URL, lease: KeyLease, endpoint: UpstreamAttempt["endpoint"]): Promise<string> {
    const started = performance.now();
    let response: Response;
    let detail: string;
    try {
      response = await this.fetchImpl(url, {
        headers: {
          Authorization: `Bearer ${lease.value}`,
          "X-Context7-Source": "context7-key-rotator-mcp",
        },
        signal: AbortSignal.timeout(API_TIMEOUT_MS),
      });
      detail = await response.text();
    } catch (error) {
      recordAttempt({ slot: lease.index, endpoint, status: "network_error", durationMs: Math.round(performance.now() - started) });
      throw new Error(`Context7 request failed: ${error instanceof Error ? error.message : String(error)}`);
    }

    const attempt: UpstreamAttempt = {
      slot: lease.index,
      endpoint,
      status: response.status,
      durationMs: Math.round(performance.now() - started),
      rateLimitRemaining: headerNumber(response.headers, "ratelimit-remaining"),
      rateLimitLimit: headerNumber(response.headers, "ratelimit-limit"),
    };

    if (response.ok) {
      recordAttempt(attempt);
      return detail;
    }

    const body = parseErrorBody(detail);
    recordAttempt({ ...attempt, code: typeof body.error === "string" ? body.error : undefined });
    throw new Context7ApiError(
      detail || `Context7 request failed with status ${response.status}.`,
      response.status,
      parseRetryAfterMs(response.headers.get("retry-after"), this.keyPool.now()),
      typeof body.error === "string" ? body.error : undefined,
      typeof body.redirectUrl === "string" ? body.redirectUrl : undefined,
    );
  }
}
