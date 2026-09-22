import { type KeyLease, RoundRobinKeyPool } from "./key-pool.js";

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
  ) {
    super(message);
  }

  public get isBlocked(): boolean {
    return this.status === 401 || this.status === 403 || this.status === 429;
  }

  /**
   * Context7 answers a documentation request for a library hidden by the key's
   * teamspace library filters with the same "not found" as an unindexed library,
   * so a 404 is worth one attempt on the other key.
   */
  public get isNotFound(): boolean {
    return this.status === 404;
  }
}

export type FetchLike = typeof fetch;

function normalizeName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * True when at least one result plausibly names the requested library. A key
 * whose teamspace filters hide the library still answers 200, but with only
 * unrelated libraries.
 */
export function hasLibraryNameMatch(response: SearchResponse, libraryName: string): boolean {
  const wanted = normalizeName(libraryName);
  if (!wanted) return true;
  return (response.results ?? []).some((result) =>
    normalizeName(result.title ?? "").includes(wanted) || normalizeName(result.id ?? "").includes(wanted),
  );
}

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
  ) {}

  public async searchLibraries(query: string, libraryName: string): Promise<SearchResponse> {
    const url = new URL(`${API_BASE_URL}/v2/libs/search`);
    url.searchParams.set("query", query);
    url.searchParams.set("libraryName", libraryName);
    return this.withBalancedKey(
      async (key) => (await this.fetchResponse(url, key)).json() as Promise<SearchResponse>,
      (response) => !response.searchFilterApplied || hasLibraryNameMatch(response, libraryName),
    );
  }

  public async fetchLibraryContext(query: string, libraryId: string): Promise<string> {
    const url = new URL(`${API_BASE_URL}/v2/context`);
    url.searchParams.set("query", query);
    url.searchParams.set("libraryId", libraryId);
    return this.withBalancedKey(async (key) => {
      const text = await (await this.fetchResponse(url, key)).text();
      return text || "Documentation not found or not finalized for this library. This might have happened because you used an invalid Context7-compatible library ID.";
    });
  }

  /**
   * Runs the operation on the next key and at most once more on the other key:
   * when the first key is blocked or reports "not found", or when its answer is
   * not acceptable (for example, filtered search results that miss the requested
   * library). An unacceptable first answer is still returned if the other key
   * cannot do better.
   */
  private async withBalancedKey<T>(
    operation: (key: string) => Promise<T>,
    acceptable: (result: T) => boolean = () => true,
  ): Promise<T> {
    const selected = this.keyPool.next();
    const alternate = this.keyPool.alternate(selected);

    let first: T;
    try {
      first = await this.attempt(selected, operation);
    } catch (error) {
      if (!(error instanceof Context7ApiError) || !(error.isBlocked || error.isNotFound)) {
        throw error;
      }
      return this.attempt(alternate, operation);
    }

    if (acceptable(first)) return first;

    try {
      const second = await this.attempt(alternate, operation);
      return acceptable(second) ? second : first;
    } catch {
      return first;
    }
  }

  private async attempt<T>(lease: KeyLease, operation: (key: string) => Promise<T>): Promise<T> {
    try {
      return await operation(lease.value);
    } catch (error) {
      if (error instanceof Context7ApiError && error.status === 429) {
        const cooldown = error.retryAfterMs ?? DEFAULT_RATE_LIMIT_COOLDOWN_MS;
        this.keyPool.coolDown(lease, Math.min(cooldown, MAX_RATE_LIMIT_COOLDOWN_MS));
      }
      throw error;
    }
  }

  private async fetchResponse(url: URL, key: string): Promise<Response> {
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        headers: {
          Authorization: `Bearer ${key}`,
          "X-Context7-Source": "context7-key-rotator-mcp",
        },
        signal: AbortSignal.timeout(API_TIMEOUT_MS),
      });
    } catch (error) {
      throw new Error(`Context7 request failed: ${error instanceof Error ? error.message : String(error)}`);
    }

    if (response.ok) {
      return response;
    }

    const detail = await response.text();
    throw new Context7ApiError(
      detail || `Context7 request failed with status ${response.status}.`,
      response.status,
      parseRetryAfterMs(response.headers.get("retry-after"), this.keyPool.now()),
    );
  }
}
