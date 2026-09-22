import { describe, expect, it } from "vitest";
import { Context7ApiClient, Context7ApiError, type FetchLike, mergeSearchResponses, parseRetryAfterMs } from "../src/context7-api.js";
import { RoundRobinKeyPool } from "../src/key-pool.js";

function fakeFetch(responses: Array<(authorization: string | null) => Response>): { fetch: FetchLike; authorizations: string[]; urls: string[] } {
  const authorizations: string[] = [];
  const urls: string[] = [];
  const fetch: FetchLike = async (url, init) => {
    const authorization = new Headers(init?.headers).get("authorization");
    authorizations.push(authorization ?? "");
    urls.push(url.toString());
    const response = responses.shift();
    if (!response) throw new Error("Unexpected fetch call");
    return response(authorization);
  };
  return { fetch, authorizations, urls };
}

function clockAt(start: number): { now: () => number; advance: (ms: number) => void } {
  let current = start;
  return { now: () => current, advance: (ms) => { current += ms; } };
}

function silentClient(pool: RoundRobinKeyPool, fetch: FetchLike, lines: string[] = []): Context7ApiClient {
  return new Context7ApiClient(pool, fetch, (line) => lines.push(line));
}

const context7 = { id: "/upstash/context7", title: "Context7", description: "docs" };
const truefoundry = { id: "/truefoundry/context7-mcp-server", title: "Context7 MCP Server", description: "mcp" };
const stripe = { id: "/websites/stripe", title: "Stripe", description: "payments" };
const fastapi = { id: "/websites/fastapi", title: "FastAPI", description: "api" };

describe("Context7ApiClient query-docs rotation", () => {
  it("balances ordinary calls between the two keys", async () => {
    const mock = fakeFetch([
      () => new Response("first", { status: 200 }),
      () => new Response("second", { status: 200 }),
    ]);
    const client = silentClient(new RoundRobinKeyPool(["one", "two"]), mock.fetch);

    await client.fetchLibraryContext("first", "/jlowin/fastmcp");
    await client.fetchLibraryContext("second", "/siderolabs/talos");

    expect(mock.authorizations).toEqual(["Bearer one", "Bearer two"]);
    expect(mock.urls).toEqual([
      "https://context7.com/api/v2/context?query=first&libraryId=%2Fjlowin%2Ffastmcp",
      "https://context7.com/api/v2/context?query=second&libraryId=%2Fsiderolabs%2Ftalos",
    ]);
  });

  it.each([401, 403, 404, 429])("retries exactly once with the alternate key for status %i", async (status) => {
    const mock = fakeFetch([
      () => new Response("blocked", { status }),
      () => new Response("focused context", { status: 200 }),
    ]);
    const client = silentClient(new RoundRobinKeyPool(["one", "two"]), mock.fetch);

    await expect(client.fetchLibraryContext("control plane", "/siderolabs/talos")).resolves.toBe("focused context");

    expect(mock.authorizations).toEqual(["Bearer one", "Bearer two"]);
    expect(mock.urls).toEqual([
      "https://context7.com/api/v2/context?query=control+plane&libraryId=%2Fsiderolabs%2Ftalos",
      "https://context7.com/api/v2/context?query=control+plane&libraryId=%2Fsiderolabs%2Ftalos",
    ]);
  });

  it("does not retry a failure that is not about the key", async () => {
    const mock = fakeFetch([() => new Response("upstream error", { status: 500 })]);
    const client = silentClient(new RoundRobinKeyPool(["one", "two"]), mock.fetch);

    await expect(client.fetchLibraryContext("docs", "/jlowin/fastmcp")).rejects.toBeInstanceOf(Context7ApiError);
    expect(mock.authorizations).toEqual(["Bearer one"]);
  });

  it("fails when both keys are blocked", async () => {
    const mock = fakeFetch([
      () => new Response("quota exhausted", { status: 429 }),
      () => new Response("rate limited", { status: 429 }),
    ]);
    const client = silentClient(new RoundRobinKeyPool(["one", "two"]), mock.fetch);

    await expect(client.fetchLibraryContext("docs", "/jlowin/fastmcp")).rejects.toBeInstanceOf(Context7ApiError);
    expect(mock.authorizations).toEqual(["Bearer one", "Bearer two"]);
  });
});

describe("Context7ApiClient resolve-library-id across both keys", () => {
  it("asks both keys and returns the same merged answer whichever key's turn it is", async () => {
    const filtered = { searchFilterApplied: true, results: [stripe, fastapi] };
    const open = { searchFilterApplied: true, results: [context7, truefoundry] };
    const mock = fakeFetch([
      () => Response.json(filtered),
      () => Response.json(open),
      () => new Response("docs", { status: 200 }),
      () => Response.json(filtered),
      () => Response.json(open),
    ]);
    const client = silentClient(new RoundRobinKeyPool(["one", "two"]), mock.fetch);

    const first = await client.searchLibraries("docs", "Context7");
    await client.fetchLibraryContext("q", "/upstash/context7");
    const second = await client.searchLibraries("docs", "Context7");

    expect(first).toEqual(second);
    expect(first.results?.map((result) => result.id)).toEqual([stripe.id, context7.id, fastapi.id, truefoundry.id]);
    expect(mock.authorizations).toEqual(["Bearer one", "Bearer two", "Bearer one", "Bearer one", "Bearer two"]);
    expect(mock.urls[0]).toBe("https://context7.com/api/v2/libs/search?query=docs&libraryName=Context7");
  });

  it("returns the other key's results when one key is blocked, and cools a rate-limited key", async () => {
    const clock = clockAt(0);
    const pool = new RoundRobinKeyPool(["one", "two"], clock.now);
    const mock = fakeFetch([
      () => new Response("rate limited", { status: 429, headers: { "Retry-After": "30" } }),
      () => Response.json({ results: [context7] }),
      () => Response.json({ results: [truefoundry] }),
    ]);
    const client = silentClient(pool, mock.fetch);

    await expect(client.searchLibraries("docs", "Context7")).resolves.toEqual({ results: [context7], searchFilterApplied: false });
    await expect(client.searchLibraries("docs", "Context7")).resolves.toEqual({ results: [truefoundry], searchFilterApplied: false });

    expect(mock.authorizations).toEqual(["Bearer one", "Bearer two", "Bearer two"]);
  });

  it("falls back to a cooling key only when every available key fails", async () => {
    const clock = clockAt(0);
    const pool = new RoundRobinKeyPool(["one", "two"], clock.now);
    pool.coolDown({ index: 0, value: "one" }, 30_000);
    const mock = fakeFetch([
      () => new Response("forbidden", { status: 403 }),
      () => Response.json({ results: [context7] }),
    ]);
    const client = silentClient(pool, mock.fetch);

    await expect(client.searchLibraries("docs", "Context7")).resolves.toEqual({ results: [context7], searchFilterApplied: false });
    expect(mock.authorizations).toEqual(["Bearer two", "Bearer one"]);
  });

  it("fails with the upstream error when every key fails", async () => {
    const mock = fakeFetch([
      () => new Response("upstream error", { status: 500 }),
      () => new Response("upstream error", { status: 500 }),
    ]);
    const client = silentClient(new RoundRobinKeyPool(["one", "two"]), mock.fetch);

    await expect(client.searchLibraries("docs", "FastMCP")).rejects.toMatchObject({ status: 500 });
    expect(mock.authorizations).toEqual(["Bearer one", "Bearer two"]);
  });

  it("logs which slot saw results the other did not, without key values", async () => {
    const lines: string[] = [];
    const mock = fakeFetch([
      () => Response.json({ searchFilterApplied: true, results: [stripe, context7] }),
      () => Response.json({ searchFilterApplied: true, results: [context7, truefoundry] }),
      () => Response.json({ results: [context7] }),
      () => Response.json({ results: [context7] }),
    ]);
    const client = silentClient(new RoundRobinKeyPool(["secret-one", "secret-two"]), mock.fetch, lines);

    await client.searchLibraries("docs", "Context7");
    await client.searchLibraries("docs", "Context7");

    expect(lines).toEqual(["Context7 search results differ by slot: slot 0 alone returned 1, slot 1 alone returned 1"]);
    expect(lines.join("\n")).not.toContain("secret");
  });
});

describe("mergeSearchResponses", () => {
  it("interleaves by rank in slot order and removes duplicates", () => {
    const merged = mergeSearchResponses([
      { results: [stripe, context7, fastapi] },
      { results: [context7, truefoundry] },
    ]);

    expect(merged.results?.map((result) => result.id)).toEqual([stripe.id, context7.id, truefoundry.id, fastapi.id]);
  });

  it("reports a filter only when every key applied one", () => {
    expect(mergeSearchResponses([{ searchFilterApplied: true, results: [] }, { searchFilterApplied: true, results: [] }]).searchFilterApplied).toBe(true);
    expect(mergeSearchResponses([{ searchFilterApplied: true, results: [] }, { results: [] }]).searchFilterApplied).toBe(false);
  });

  it("handles responses without results", () => {
    expect(mergeSearchResponses([{}, {}])).toEqual({ results: [], searchFilterApplied: false });
  });
});

describe("Context7ApiClient rate-limit cooldown", () => {
  it("skips a rate-limited key until its Retry-After window passes", async () => {
    const clock = clockAt(1_000_000);
    const mock = fakeFetch([
      () => new Response("rate limited", { status: 429, headers: { "Retry-After": "30" } }),
      () => new Response("from two", { status: 200 }),
      () => new Response("from two again", { status: 200 }),
      () => new Response("from two third", { status: 200 }),
      () => new Response("from two after cooldown", { status: 200 }),
      () => new Response("from one", { status: 200 }),
    ]);
    const client = silentClient(new RoundRobinKeyPool(["one", "two"], clock.now), mock.fetch);

    await client.fetchLibraryContext("q", "/a/b");
    await client.fetchLibraryContext("q", "/a/b");
    await client.fetchLibraryContext("q", "/a/b");
    clock.advance(30_001);
    await client.fetchLibraryContext("q", "/a/b");
    await client.fetchLibraryContext("q", "/a/b");

    // One 429 plus its fallback, then key one is skipped until the window passes and rotation resumes.
    expect(mock.authorizations).toEqual(["Bearer one", "Bearer two", "Bearer two", "Bearer two", "Bearer two", "Bearer one"]);
  });

  it("uses a default cooldown when Retry-After is missing and caps long ones", async () => {
    const clock = clockAt(0);
    const pool = new RoundRobinKeyPool(["one", "two"], clock.now);
    const mock = fakeFetch([
      () => new Response("rate limited", { status: 429 }),
      () => new Response("ok", { status: 200 }),
      () => new Response("rate limited", { status: 429, headers: { "Retry-After": String(24 * 60 * 60) } }),
      () => new Response("ok", { status: 200 }),
    ]);
    const client = silentClient(pool, mock.fetch);

    await client.fetchLibraryContext("q", "/a/b");
    expect(pool.isCoolingDown(0)).toBe(true);
    clock.advance(60_001);
    expect(pool.isCoolingDown(0)).toBe(false);

    await client.fetchLibraryContext("q", "/a/b");
    expect(pool.isCoolingDown(1)).toBe(true);
    clock.advance(60 * 60_000 + 1);
    expect(pool.isCoolingDown(1)).toBe(false);
  });

  it("still uses ordinary rotation when both keys are cooling down", () => {
    const clock = clockAt(0);
    const pool = new RoundRobinKeyPool(["one", "two"], clock.now);
    pool.coolDown({ index: 0, value: "one" }, 10_000);
    pool.coolDown({ index: 1, value: "two" }, 10_000);

    expect(pool.next().value).toBe("one");
    expect(pool.next().value).toBe("two");
  });

  it("logs cooldowns and retries by slot without key values", async () => {
    const lines: string[] = [];
    const mock = fakeFetch([
      () => new Response("rate limited", { status: 429, headers: { "Retry-After": "5" } }),
      () => new Response("docs", { status: 200 }),
    ]);
    const client = silentClient(new RoundRobinKeyPool(["secret-one", "secret-two"]), mock.fetch, lines);

    await client.fetchLibraryContext("q", "/a/b");

    expect(lines).toEqual([
      "Context7 slot 0 rate limited; cooling down for 5s",
      "Context7 slot 0 returned 429; retrying on slot 1",
    ]);
    expect(lines.join("\n")).not.toContain("secret");
  });
});

describe("parseRetryAfterMs", () => {
  it("parses delta seconds, HTTP dates, and rejects garbage", () => {
    const now = Date.parse("2026-09-22T12:00:00Z");
    expect(parseRetryAfterMs("30", now)).toBe(30_000);
    expect(parseRetryAfterMs("Tue, 22 Sep 2026 12:01:00 GMT", now)).toBe(60_000);
    expect(parseRetryAfterMs("soon", now)).toBeUndefined();
    expect(parseRetryAfterMs(null, now)).toBeUndefined();
  });
});

describe("RoundRobinKeyPool.fromEnvironment", () => {
  it.each([
    ["empty value", ""],
    ["one key", "one"],
    ["three keys", "one,two,three"],
  ])("rejects %s", (_scenario, value) => {
    expect(() => RoundRobinKeyPool.fromEnvironment(value)).toThrow(
      "CONTEXT7_API_KEYS must contain exactly two non-empty keys.",
    );
  });

  it("accepts exactly two comma-separated keys", () => {
    const pool = RoundRobinKeyPool.fromEnvironment(" one , two ");

    expect(pool.next()).toEqual({ index: 0, value: "one" });
    expect(pool.next()).toEqual({ index: 1, value: "two" });
  });
});
