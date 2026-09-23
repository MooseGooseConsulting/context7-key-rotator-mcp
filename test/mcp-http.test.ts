import type { Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { Context7ApiClient, type FetchLike } from "../src/context7-api.js";
import { createHttpMcpServer, type HttpServerOptions } from "../src/http-server.js";
import { RoundRobinKeyPool } from "../src/key-pool.js";

const protocolVersion = "2026-07-28";
const clientMeta = {
  "io.modelcontextprotocol/protocolVersion": protocolVersion,
  "io.modelcontextprotocol/clientInfo": { name: "integration-test", version: "1.0.0" },
  "io.modelcontextprotocol/clientCapabilities": {},
};

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => {
    server.closeIdleConnections();
    server.closeAllConnections();
    server.close((error) => error ? reject(error) : resolve());
  })));
});

function createApi(): Context7ApiClient {
  const fetchImpl: FetchLike = async (url) => {
    const path = new URL(url).pathname;
    if (path === "/api/v2/libs/search") {
      return Response.json({
        results: [{
          id: "/prefecthq/fastmcp",
          title: "FastMCP",
          description: "A framework for MCP servers.",
          totalSnippets: 42,
          trustScore: 9,
          benchmarkScore: 88.5,
        }],
      });
    }
    if (path === "/api/v2/context") return new Response("Focused FastMCP documentation.");
    return new Response("unexpected path", { status: 500 });
  };
  return new Context7ApiClient(new RoundRobinKeyPool(["one", "two"]), fetchImpl);
}

async function startServer(api = createApi(), options: HttpServerOptions = {}): Promise<string> {
  const server = createHttpMcpServer(api, options);
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    server.once("error", onError);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", onError);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected a TCP listener.");
  return `http://127.0.0.1:${address.port}/mcp`;
}

async function postMcp(url: string, method: "tools/list" | "tools/call", id: number, name?: string, arguments_?: Record<string, string>) {
  const params: Record<string, unknown> = { _meta: clientMeta };
  if (method === "tools/call") {
    params.name = name;
    params.arguments = arguments_;
  }
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Accept: "application/json, text/event-stream",
      "Content-Type": "application/json",
      Connection: "close",
      "MCP-Protocol-Version": protocolVersion,
      "MCP-Method": method,
      ...(name ? { "MCP-Name": name } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
  expect(response.status).toBe(200);
  return response.json() as Promise<Record<string, any>>;
}

describe("Streamable HTTP MCP endpoint", () => {
  it("discovers only the two Context7 tools", async () => {
    const response = await postMcp(await startServer(), "tools/list", 1);

    expect(response.result.tools.map((tool: { name: string }) => tool.name)).toEqual([
      "resolve-library-id",
      "query-docs",
    ]);
  });

  it("serves native-compatible search formatting and Context7 V2 docs", async () => {
    const endpoint = await startServer();
    const search = await postMcp(endpoint, "tools/call", 2, "resolve-library-id", {
      libraryName: "FastMCP",
      query: "Create a Streamable HTTP server",
    });
    const docs = await postMcp(endpoint, "tools/call", 3, "query-docs", {
      libraryId: "/prefecthq/fastmcp",
      query: "Create a Streamable HTTP server",
    });

    expect(search.result.content[0].text).toContain("Available Libraries:");
    expect(search.result.content[0].text).toContain("Context7-compatible library ID: /prefecthq/fastmcp");
    expect(docs.result.content[0].text).toBe("Focused FastMCP documentation.");
  });

  it("returns an MCP tool error after both Context7 keys are blocked", async () => {
    const blockedFetch: FetchLike = async () => new Response("both keys blocked", { status: 429 });
    const api = new Context7ApiClient(new RoundRobinKeyPool(["one", "two"]), blockedFetch);

    const response = await postMcp(await startServer(api), "tools/call", 4, "query-docs", {
      libraryId: "/prefecthq/fastmcp",
      query: "Create a Streamable HTTP server",
    });

    expect(response.result.isError).toBe(true);
    expect(response.result.content[0].text).toBe("both keys blocked");
  });

  it("records one event per tool call with the caller, arguments, and every upstream attempt", async () => {
    const fetchImpl: FetchLike = async (url) => {
      const path = new URL(url).pathname;
      const headers = { "RateLimit-Limit": "1000", "RateLimit-Remaining": "570" };
      if (path === "/api/v2/libs/search") return Response.json({ results: [{ id: "/a/b", title: "B", description: "" }] }, { headers });
      return Response.json({ error: "no_relevant_snippets", message: "No documentation matched." }, { status: 404, headers });
    };
    const api = new Context7ApiClient(new RoundRobinKeyPool(["secret-one", "secret-two"]), fetchImpl, () => {});
    const events: Array<Record<string, any>> = [];
    const endpoint = await startServer(api, { record: (event) => events.push(event) });

    await postMcp(endpoint, "tools/call", 5, "resolve-library-id", { libraryName: "B", query: "setup" });
    await postMcp(endpoint, "tools/call", 6, "query-docs", { libraryId: "/a/b", query: "setup" });

    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      event: "tool_call", tool: "resolve-library-id", libraryName: "B", query: "setup", outcome: "ok", resultCount: 1, upstreamCalls: 2,
    });
    expect(events[0].attempts.map((attempt: Record<string, unknown>) => attempt.slot)).toEqual([0, 1]);
    expect(events[0].attempts[0]).toMatchObject({ endpoint: "search", status: 200, rateLimitLimit: 1000, rateLimitRemaining: 570 });
    expect(events[1]).toMatchObject({
      tool: "query-docs", libraryId: "/a/b", outcome: "error", errorStatus: 404, errorCode: "no_relevant_snippets", upstreamCalls: 1,
    });
    expect(events[1].attempts[0]).toMatchObject({ endpoint: "context", status: 404, code: "no_relevant_snippets" });
    expect(events[0].requestId).not.toBe(events[1].requestId);
    expect(typeof events[0].userAgent).toBe("string");
    expect(JSON.stringify(events)).not.toContain("secret");
  });
});
