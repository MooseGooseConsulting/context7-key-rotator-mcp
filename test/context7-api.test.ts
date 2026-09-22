import { describe, expect, it } from "vitest";
import { Context7ApiClient, Context7ApiError, type FetchLike, hasLibraryNameMatch, parseRetryAfterMs } from "../src/context7-api.js";
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

describe("Context7ApiClient", () => {
  it("balances ordinary calls between the two keys", async () => {
    const mock = fakeFetch([
      () => Response.json({ results: [] }),
      () => Response.json({ results: [] }),
    ]);
    const client = new Context7ApiClient(new RoundRobinKeyPool(["one", "two"]), mock.fetch);

    await client.searchLibraries("first", "FastMCP");
    await client.searchLibraries("second", "Talos");

    expect(mock.authorizations).toEqual(["Bearer one", "Bearer two"]);
    expect(mock.urls).toEqual([
      "https://context7.com/api/v2/libs/search?query=first&libraryName=FastMCP",
      "https://context7.com/api/v2/libs/search?query=second&libraryName=Talos",
    ]);
  });

  it.each([401, 403, 429])("retries exactly once with the alternate key for blocked status %i", async (status) => {
    const mock = fakeFetch([
      () => new Response("blocked", { status }),
      () => new Response("focused context", { status: 200 }),
    ]);
    const client = new Context7ApiClient(new RoundRobinKeyPool(["one", "two"]), mock.fetch);

    await expect(client.fetchLibraryContext("control plane", "/siderolabs/talos")).resolves.toBe("focused context");

    expect(mock.authorizations).toEqual(["Bearer one", "Bearer two"]);
    expect(mock.urls).toEqual([
      "https://context7.com/api/v2/context?query=control+plane&libraryId=%2Fsiderolabs%2Ftalos",
      "https://context7.com/api/v2/context?query=control+plane&libraryId=%2Fsiderolabs%2Ftalos",
    ]);
  });

  it("does not retry a non-blocked upstream failure", async () => {
    const mock = fakeFetch([
      () => new Response("upstream error", { status: 500 }),
    ]);
    const client = new Context7ApiClient(new RoundRobinKeyPool(["one", "two"]), mock.fetch);

    await expect(client.searchLibraries("docs", "FastMCP")).rejects.toBeInstanceOf(Context7ApiError);

    expect(mock.authorizations).toEqual(["Bearer one"]);
    expect(mock.urls).toEqual([
      "https://context7.com/api/v2/libs/search?query=docs&libraryName=FastMCP",
    ]);
  });

  it("fails when both keys are blocked", async () => {
    const mock = fakeFetch([
      () => new Response("quota exhausted", { status: 429 }),
      () => new Response("rate limited", { status: 429 }),
    ]);
    const client = new Context7ApiClient(new RoundRobinKeyPool(["one", "two"]), mock.fetch);

    await expect(client.searchLibraries("docs", "FastMCP")).rejects.toBeInstanceOf(Context7ApiError);
    expect(mock.authorizations).toEqual(["Bearer one", "Bearer two"]);
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

const matching = { searchFilterApplied: true, results: [{ id: "/upstash/context7", title: "Context7", description: "docs" }] };
const unrelated = { searchFilterApplied: true, results: [{ id: "/websites/stripe", title: "Stripe", description: "payments" }] };

function clockAt(start: number): { now: () => number; advance: (ms: number) => void } {
  let current = start;
  return { now: () => current, advance: (ms) => { current += ms; } };
}

describe("Context7ApiClient key divergence", () => {
  it("retries a 404 with the alternate key because filtered libraries look not found", async () => {
    const mock = fakeFetch([
      () => new Response(JSON.stringify({ error: "library_not_found" }), { status: 404 }),
      () => new Response("focused context", { status: 200 }),
    ]);
    const client = new Context7ApiClient(new RoundRobinKeyPool(["one", "two"]), mock.fetch);

    await expect(client.fetchLibraryContext("hooks", "/facebook/react")).resolves.toBe("focused context");
    expect(mock.authorizations).toEqual(["Bearer one", "Bearer two"]);
  });

  it("returns the alternate key's results when filtered results miss the requested library", async () => {
    const mock = fakeFetch([() => Response.json(unrelated), () => Response.json(matching)]);
    const client = new Context7ApiClient(new RoundRobinKeyPool(["one", "two"]), mock.fetch);

    await expect(client.searchLibraries("docs", "Context7")).resolves.toEqual(matching);
    expect(mock.authorizations).toEqual(["Bearer one", "Bearer two"]);
  });

  it("keeps the first filtered results when the alternate key does no better", async () => {
    const other = { searchFilterApplied: true, results: [{ id: "/websites/fastapi", title: "FastAPI", description: "api" }] };
    const mock = fakeFetch([() => Response.json(unrelated), () => Response.json(other)]);
    const client = new Context7ApiClient(new RoundRobinKeyPool(["one", "two"]), mock.fetch);

    await expect(client.searchLibraries("docs", "Context7")).resolves.toEqual(unrelated);
  });

  it("keeps the first filtered results when the alternate key fails", async () => {
    const mock = fakeFetch([() => Response.json(unrelated), () => new Response("rate limited", { status: 429 })]);
    const client = new Context7ApiClient(new RoundRobinKeyPool(["one", "two"]), mock.fetch);

    await expect(client.searchLibraries("docs", "Context7")).resolves.toEqual(unrelated);
  });

  it("does not spend a second call on filtered results that already match", async () => {
    const mock = fakeFetch([() => Response.json(matching)]);
    const client = new Context7ApiClient(new RoundRobinKeyPool(["one", "two"]), mock.fetch);

    await expect(client.searchLibraries("docs", "Context7")).resolves.toEqual(matching);
    expect(mock.authorizations).toEqual(["Bearer one"]);
  });

  it("does not spend a second call on unfiltered results", async () => {
    const unfiltered = { ...unrelated, searchFilterApplied: false };
    const mock = fakeFetch([() => Response.json(unfiltered)]);
    const client = new Context7ApiClient(new RoundRobinKeyPool(["one", "two"]), mock.fetch);

    await expect(client.searchLibraries("docs", "Context7")).resolves.toEqual(unfiltered);
    expect(mock.authorizations).toEqual(["Bearer one"]);
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
    const client = new Context7ApiClient(new RoundRobinKeyPool(["one", "two"], clock.now), mock.fetch);

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
    const client = new Context7ApiClient(pool, mock.fetch);

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
});

describe("hasLibraryNameMatch", () => {
  it.each([
    ["Next.js", "/vercel/next.js", "Next.js", true],
    ["context7", "/upstash/context7", "Context7", true],
    ["Model Context Protocol", "/modelcontextprotocol/typescript-sdk", "MCP TypeScript SDK", true],
    ["context7", "/websites/stripe", "Stripe", false],
  ])("%s against %s is %s", (libraryName, id, title, expected) => {
    expect(hasLibraryNameMatch({ results: [{ id, title, description: "" }] }, libraryName)).toBe(expected);
  });

  it("treats empty results as no match", () => {
    expect(hasLibraryNameMatch({ results: [] }, "react")).toBe(false);
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

describe("Context7ApiClient slot logging", () => {
  it("logs slot indexes and reasons without key values", async () => {
    const lines: string[] = [];
    const mock = fakeFetch([
      () => new Response("rate limited", { status: 429, headers: { "Retry-After": "5" } }),
      () => new Response("docs", { status: 200 }),
      () => Response.json(unrelated),
      () => Response.json(matching),
    ]);
    const client = new Context7ApiClient(new RoundRobinKeyPool(["secret-one", "secret-two"]), mock.fetch, (line) => lines.push(line));

    await client.fetchLibraryContext("q", "/a/b");
    await client.searchLibraries("docs", "Context7");

    expect(lines).toEqual([
      "Context7 slot 0 rate limited; cooling down for 5s",
      "Context7 slot 0 returned 429; retrying on slot 1",
      "Context7 slot 1 filtered search missed the requested library; slot 0 matched",
    ]);
    expect(lines.join("\n")).not.toContain("secret");
  });
});
