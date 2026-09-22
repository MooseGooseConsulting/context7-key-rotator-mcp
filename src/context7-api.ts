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

/**
 * Merges search responses from different keys in slot order. Results are
 * interleaved by rank and de-duplicated by library ID, so a library visible to
 * either key's teamspace appears no matter which key's turn it is. The merged
 * response only reports a filter when every contributing key applied one.
 */
export function mergeSearchResponses(responses: readonly SearchResponse[]): SearchResponse {
  const lists = responses.map((response) => response.results ?? []);
  const longest = Math.max(0, ...lists.map((list) => list.length));
  const seen = new Set<string>();
  const results: SearchResult[] = [];
  for (let rank = 0; rank < longest; rank += 1) {
    for (const list of lists) {
      const result = list[rank];
      if (result && !seen.has(result.id)) {
        seen.add(result.id);
        results.push(result);
      }
    }
  }
  return { results, searchFilterApplied: responses.length > 0 && responses.every((response) => response.searchFilterApplied) };
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
    private readonly log: (message: string) => void = (message) => console.error(message),
  ) {}

  public async searchLibraries(query: string, libraryName: string): Promise<SearchResponse> {
    const url = new URL(`${API_BASE_URL}/v2/libs/search`);
    url.searchParams.set("query", query);
    url.searchParams.set("libraryName", libraryName);
    return this.withEveryKey(async (key) => (await this.fetchResponse(url, key)).json() as Promise<SearchResponse>);
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
   * Searches with every key that is not cooling down, in parallel, and merges
   * the answers, so what a caller sees does not depend on whose turn it is when
   * the keys' teamspaces filter libraries differently. Keys skipped for a
   * cooldown are tried only if every available key failed.
   */
  private async withEveryKey(operation: (key: string) => Promise<SearchResponse>): Promise<SearchResponse> {
    const leases = this.keyPool.leases();
    const available = leases.filter((lease) => !this.keyPool.isCoolingDown(lease.index));
    const cooling = leases.filter((lease) => this.keyPool.isCoolingDown(lease.index));
    const answered: Array<{ lease: KeyLease; response: SearchResponse }> = [];
    const failures: unknown[] = [];

    for (const batch of available.length ? [available, cooling] : [cooling]) {
      const settled = await Promise.allSettled(batch.map((lease) => this.attempt(lease, operation)));
      settled.forEach((outcome, position) => {
        if (outcome.status === "fulfilled") answered.push({ lease: batch[position], response: outcome.value });
        else failures.push(outcome.reason);
      });
      if (answered.length) break;
    }

    if (!answered.length) throw failures[0];
    if (answered.length > 1) this.logSearchDivergence(answered);
    return mergeSearchResponses(answered.map(({ response }) => response));
  }

  private logSearchDivergence(answered: ReadonlyArray<{ lease: KeyLease; response: SearchResponse }>): void {
    const ids = answered.map(({ response }) => new Set((response.results ?? []).map((result) => result.id)));
    const unique = ids.map((own, position) => [...own].filter((id) => ids.every((other, index) => index === position || !other.has(id))).length);
    if (unique.every((count) => count === 0)) return;
    this.log(`Context7 search results differ by slot: ${answered.map(({ lease }, position) => `slot ${lease.index} alone returned ${unique[position]}`).join(", ")}`);
  }

  /**
   * Runs the operation on the next key and at most once more on the other key
   * when the first key is blocked or reports "not found".
   */
  private async withBalancedKey<T>(operation: (key: string) => Promise<T>): Promise<T> {
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

  private async attempt<T>(lease: KeyLease, operation: (key: string) => Promise<T>): Promise<T> {
    try {
      return await operation(lease.value);
    } catch (error) {
      if (error instanceof Context7ApiError && error.status === 429) {
        const cooldown = Math.min(error.retryAfterMs ?? DEFAULT_RATE_LIMIT_COOLDOWN_MS, MAX_RATE_LIMIT_COOLDOWN_MS);
        this.keyPool.coolDown(lease, cooldown);
        this.log(`Context7 slot ${lease.index} rate limited; cooling down for ${Math.ceil(cooldown / 1000)}s`);
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
