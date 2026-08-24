import { once } from "node:events";
import type { Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { Context7ApiClient, type FetchLike } from "../src/context7-api.js";
import { createHttpMcpServer } from "../src/http-server.js";
import { RoundRobinKeyPool } from "../src/key-pool.js";

const protocolVersion = "2026-07-28";
const clientMeta = {
  "io.modelcontextprotocol/protocolVersion": protocolVersion,
  "io.modelcontextprotocol/clientInfo": { name: "integration-test", version: "1.0.0" },
  "io.modelcontextprotocol/clientCapabilities": {},
};

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map(async (server) => {
    server.close();
    await once(server, "close");
  }));
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

async function startServer(api = createApi()): Promise<string> {
  const server = createHttpMcpServer(api);
  servers.push(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
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
});
