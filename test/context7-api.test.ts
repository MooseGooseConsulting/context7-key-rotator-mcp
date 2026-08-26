import { describe, expect, it } from "vitest";
import { Context7ApiClient, Context7ApiError, type FetchLike } from "../src/context7-api.js";
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
