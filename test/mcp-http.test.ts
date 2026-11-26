import { mkdtemp, writeFile } from "node:fs/promises";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

async function postMcp(url: string, method: "tools/list" | "tools/call", id: number, name?: string, arguments_?: Record<string, unknown>) {
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
  it("lists upstream's tools except submit-docs-feedback, plus the usage tool", async () => {
    const response = await postMcp(await startServer(), "tools/list", 1);

    expect(response.result.tools.map((tool: { name: string }) => tool.name)).toEqual([
      "resolve-library-id",
      "query-docs",
      "get-upgrade-guide",
      "grep-code",
      "glob-code",
      "read-code",
      "find-symbol",
      "context7-usage",
    ]);
  });

  it("serves the bundled installer, and a 404 when the build has none", async () => {
    const dir = await mkdtemp(join(tmpdir(), "rotator-installer-"));
    const installerPath = join(dir, "install.mjs");
    await writeFile(installerPath, "console.log('installer');\n");
    const withInstaller = (await startServer(createApi(), { installerPath })).replace(/\/mcp$/, "");
    const without = (await startServer(createApi(), { installerPath: join(dir, "missing.mjs") })).replace(/\/mcp$/, "");

    const served = await fetch(`${withInstaller}/install.mjs`, { headers: { Connection: "close" } });
    const missing = await fetch(`${without}/install.mjs`, { headers: { Connection: "close" } });

    expect(served.status).toBe(200);
    expect(served.headers.get("content-type")).toContain("javascript");
    expect(await served.text()).toBe("console.log('installer');\n");
    expect(missing.status).toBe(404);
    await missing.body?.cancel();
  });

  it("reports each key's usage and experimental tools by slot, and a key whose usage cannot be read", async () => {
    const seen: string[] = [];
    const fetchImpl: FetchLike = async (url, init) => {
      const headers = new Headers(init?.headers);
      const auth = headers.get("authorization") ?? "";
      const path = new URL(url).pathname;
      seen.push(`${path} ${auth} experimental=${headers.get("x-context7-experimental") ?? "-"}`);
      if (path === "/api/v2/mcp/experimental-tools") {
        return Response.json(auth === "Bearer one" ? { all: false, tools: ["code-tools", "get-upgrade-guide"] } : { all: true });
      }
      if (auth === "Bearer two") return new Response("{\"error\":\"unauthorized\"}", { status: 401 });
      return Response.json({
        plan: "free",
        usageResetsAt: "2026-12-01T00:00:00Z",
        member: { requests: 120, includedInPlan: 1000 },
        teamspace: { extraRequests: 0 },
      });
    };
    const api = new Context7ApiClient(new RoundRobinKeyPool(["one", "two"]), fetchImpl);

    const response = await postMcp(await startServer(api), "tools/call", 9, "context7-usage", {});
    const text: string = response.result.content[0].text;

    // Neither lookup sends the experimental header: it would change what the lookup reports.
    expect(seen.sort()).toEqual([
      "/api/v2/mcp/experimental-tools Bearer one experimental=-",
      "/api/v2/mcp/experimental-tools Bearer two experimental=-",
      "/api/v2/usage Bearer one experimental=-",
      "/api/v2/usage Bearer two experimental=-",
    ]);
    expect(response.result.isError).toBeUndefined();
    expect(text).toContain("Key slot 0 (free plan):\n- Requests this month: 120 of 1000 (880 left)\n- Resets: 2026-12-01T00:00:00Z\n- Experimental tools: code-tools, get-upgrade-guide");
    expect(text).toContain("Key slot 1: usage unavailable:");
    expect(text).toContain("- Experimental tools: all on");
    expect(text).not.toMatch(/Bearer|\bone\b|\btwo\b/);
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
      event: "tool_call", tool: "resolve-library-id", libraryName: "B", query: "setup", outcome: "ok", resultCount: 1, upstreamCalls: 1,
    });
    expect(events[0].attempts.map((attempt: Record<string, unknown>) => attempt.slot)).toEqual([0]);
    expect(events[1].attempts.map((attempt: Record<string, unknown>) => attempt.slot)).toEqual([1]);
    expect(events[0].attempts[0]).toMatchObject({ endpoint: "search", status: 200, rateLimitLimit: 1000, rateLimitRemaining: 570 });
    expect(events[1]).toMatchObject({
      tool: "query-docs", libraryId: "/a/b", outcome: "error", errorStatus: 404, errorCode: "no_relevant_snippets", errorMessage: "No documentation matched.", upstreamCalls: 1,
    });
    expect(events[1].attempts[0]).toMatchObject({ endpoint: "context", status: 404, code: "no_relevant_snippets" });
    expect(events[0].requestId).not.toBe(events[1].requestId);
    expect(typeof events[0].userAgent).toBe("string");
    expect(JSON.stringify(events)).not.toContain("secret");
  });

  it("records a followed redirect and an empty answer on the call that saw them", async () => {
    let contextCalls = 0;
    const fetchImpl: FetchLike = async (url) => {
      if (new URL(url).searchParams.get("libraryId") === "/old/lib" && contextCalls++ === 0) {
        return Response.json({ error: "library_redirected", redirectUrl: "/new/lib" }, { status: 301 });
      }
      return new Response("");
    };
    const api = new Context7ApiClient(new RoundRobinKeyPool(["one", "two"]), fetchImpl, () => {});
    const events: Array<Record<string, any>> = [];
    const endpoint = await startServer(api, { record: (event) => events.push(event) });

    await postMcp(endpoint, "tools/call", 7, "query-docs", { libraryId: "/old/lib", query: "setup" });
    await postMcp(endpoint, "tools/call", 8, "query-docs", { libraryId: "/new/lib", query: "setup" });

    expect(events[0]).toMatchObject({ redirectedTo: "/new/lib", outcome: "empty", upstreamCalls: 2 });
    expect(events[1].redirectedTo).toBeUndefined();
    expect(events[1].upstreamCalls).toBe(1);
  });
});

describe("tools ported from upstream", () => {
  /** A fake Context7 that records each request's path, query and key, and answers from `reply`. */
  function recordingApi(reply: (path: string, params: URLSearchParams, key: string) => Response) {
    const calls: Array<{ path: string; params: URLSearchParams; key: string; headers: Headers }> = [];
    const fetchImpl: FetchLike = async (url, init) => {
      const parsed = new URL(url);
      const headers = new Headers(init?.headers);
      const key = (headers.get("authorization") ?? "").replace("Bearer ", "");
      calls.push({ path: parsed.pathname, params: parsed.searchParams, key, headers });
      return reply(parsed.pathname, parsed.searchParams, key);
    };
    return { api: new Context7ApiClient(new RoundRobinKeyPool(["one", "two"]), fetchImpl), calls };
  }

  it("passes query-docs language and version through, and accepts upstream's argument aliases", async () => {
    const { api, calls } = recordingApi(() => new Response("Docs for 14."));
    const response = await postMcp(await startServer(api), "tools/call", 1, "query-docs", {
      libraryID: "/vercel/next.js",
      question: "App router caching",
      language: "TypeScript",
      version: "14",
    });

    expect(response.result.content[0].text).toBe("Docs for 14.");
    expect(calls[0].path).toBe("/api/v2/context");
    expect(Object.fromEntries(calls[0].params)).toEqual({
      query: "App router caching",
      libraryId: "/vercel/next.js",
      language: "TypeScript",
      version: "14",
    });
    expect(calls[0].headers.get("x-context7-code-tools")).toBe("1");
  });

  it("marks search results whose source the code tools can read", async () => {
    const { api } = recordingApi(() => Response.json({
      results: [
        { id: "/colinhacks/zod", title: "Zod", description: "Schemas." },
        { id: "/websites/zod_dev", title: "Zod site", description: "Docs site." },
      ],
    }));
    const response = await postMcp(await startServer(api), "tools/call", 2, "resolve-library-id", { libraryName: "Zod", query: "schemas" });
    const [repo, site] = (response.result.content[0].text as string).split("----------");

    expect(repo).toContain("- Source code: searchable with grep-code");
    expect(site).not.toContain("Source code");
  });

  it("answers get-upgrade-guide while the guide is prepared, and for a version Context7 does not know", async () => {
    let call = 0;
    const { api, calls } = recordingApi(() => (++call === 1
      ? Response.json({ retryAfter: 90, message: "Indexing 15.0.0." }, { status: 202 })
      : Response.json({ error: "version_not_found", message: "No release 99. Known: 14, 15." }, { status: 404 })));
    const endpoint = await startServer(api);

    const preparing = await postMcp(endpoint, "tools/call", 3, "get-upgrade-guide", { libraryId: "/vercel/next.js", fromVersion: "14", toVersion: "15" });
    const unknown = await postMcp(endpoint, "tools/call", 4, "get-upgrade-guide", { libraryId: "/vercel/next.js", fromVersion: "99", page: "2" });

    expect(Object.fromEntries(calls[0].params)).toEqual({ libraryId: "/vercel/next.js", fromVersion: "14", toVersion: "15", page: "1" });
    expect(preparing.result.content[0].text).toBe("The upgrade guide is being prepared. Call 'get-upgrade-guide' again with the same arguments after 90 seconds.\n\nIndexing 15.0.0.");
    expect(preparing.result.isError).toBeUndefined();
    expect(calls[1].params.get("page")).toBe("2");
    expect(unknown.result.content[0].text).toBe("No release 99. Known: 14, 15.");
    expect(unknown.result.isError).toBeUndefined();
    // A known answer code is not a key problem, so it is not retried on the other key.
    expect(calls).toHaveLength(2);
  });

  it("sends grep-code as a /v2/code grep, and turns 'being indexed' into an answer", async () => {
    const { api, calls } = recordingApi(() => Response.json({ message: "Indexing zod v3.24.2. Call again in 30 seconds." }, { status: 202 }));
    const response = await postMcp(await startServer(api), "tools/call", 5, "grep-code", {
      libraryId: "/colinhacks/zod",
      regex: "safeParse",
      type: "ts",
      "-i": true,
    });

    expect(calls[0].path).toBe("/api/v2/code");
    expect(calls[0].params.get("operation")).toBe("grep");
    expect(calls[0].params.get("pattern")).toBe("safeParse");
    expect(calls[0].params.getAll("glob")).toEqual(["*.ts", "*.tsx", "*.mts", "*.cts"]);
    expect(calls[0].params.get("ignore_case")).toBe("true");
    expect(calls[0].params.get("wait")).toBe("5");
    const text: string = response.result.content[0].text;
    expect(response.result.isError).toBeUndefined();
    expect(text).toContain("Indexing zod v3.24.2.");
    expect(text).not.toContain("Call again in 30 seconds");
    expect(text).toContain("answer from query-docs now");
  });

  it("retries a code call refused by one key on the other, and explains a code search that is off", async () => {
    const { api, calls } = recordingApi(() => Response.json(
      { error: "code_search_unavailable", message: "Source code search is not on for this teamspace." },
      { status: 403 },
    ));
    const response = await postMcp(await startServer(api), "tools/call", 6, "read-code", { libraryId: "/colinhacks/zod", path: "src/types.ts" });

    expect(calls.map((call) => call.key)).toEqual(["one", "two"]);
    expect(calls[0].params.get("operation")).toBe("read");
    expect(calls[0].params.get("path")).toBe("src/types.ts");
    expect(response.result.isError).toBe(true);
    expect(response.result.content[0].text).toBe("Source code search is not on for this teamspace. Answer from query-docs.");
  });

  it("rewrites a code result's hints into calls of these tools", async () => {
    const { api } = recordingApi(() => new Response("Library: /colinhacks/zod\n2 matching lines in 1 file\nsrc/types.ts:10: safeParse\nNext: read: src/types.ts#L5-L15"));
    const response = await postMcp(await startServer(api), "tools/call", 7, "grep-code", { libraryId: "/colinhacks/zod", pattern: "safeParse" });

    expect(response.result.content[0].text).toContain('Next: read-code with file_path "src/types.ts", offset 5, limit 11');
  });
});
