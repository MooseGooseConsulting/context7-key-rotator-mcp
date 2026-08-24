import { RoundRobinKeyPool } from "./key-pool.js";

const API_BASE_URL = "https://context7.com/api";
const API_TIMEOUT_MS = 60_000;

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
  ) {
    super(message);
  }

  public get isBlocked(): boolean {
    return this.status === 401 || this.status === 403 || this.status === 429;
  }
}

export type FetchLike = typeof fetch;

export class Context7ApiClient {
  public constructor(
    private readonly keyPool: RoundRobinKeyPool,
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  public async searchLibraries(query: string, libraryName: string): Promise<SearchResponse> {
    const url = new URL(`${API_BASE_URL}/v2/libs/search`);
    url.searchParams.set("query", query);
    url.searchParams.set("libraryName", libraryName);
    return this.requestJson<SearchResponse>(url);
  }

  public async fetchLibraryContext(query: string, libraryId: string): Promise<string> {
    const url = new URL(`${API_BASE_URL}/v2/context`);
    url.searchParams.set("query", query);
    url.searchParams.set("libraryId", libraryId);
    return this.requestText(url);
  }

  private async requestJson<T>(url: URL): Promise<T> {
    return this.withBalancedKey(async (key) => {
      const response = await this.fetchResponse(url, key);
      return response.json() as Promise<T>;
    });
  }

  private async requestText(url: URL): Promise<string> {
    return this.withBalancedKey(async (key) => {
      const response = await this.fetchResponse(url, key);
      const text = await response.text();
      return text || "Documentation not found or not finalized for this library. This might have happened because you used an invalid Context7-compatible library ID.";
    });
  }

  private async withBalancedKey<T>(operation: (key: string) => Promise<T>): Promise<T> {
    const selected = this.keyPool.next();
    try {
      return await operation(selected.value);
    } catch (error) {
      if (!(error instanceof Context7ApiError) || !error.isBlocked) {
        throw error;
      }

      return operation(this.keyPool.alternate(selected).value);
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
    );
  }
}
