import { createServer, type Server } from "node:http";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { Context7ApiClient } from "./context7-api.js";
import { createContext7McpServer } from "./mcp-server.js";

export function createHttpMcpServer(api: Context7ApiClient): Server {
  const handler = createMcpHandler(() => createContext7McpServer(api), {
    keepAliveMs: 0,
    onerror: (error) => console.error("MCP handler error", error),
  });
  const nodeHandler = toNodeHandler(handler, {
    onerror: (error) => console.error("MCP node adapter error", error),
  });

  return createServer(async (request, response) => {
    const requestUrl = new URL(request.url ?? "/", "http://localhost");
    if (requestUrl.pathname !== "/mcp") {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "not_found", message: "Use POST /mcp." }));
      return;
    }
    if (request.method !== "POST") {
      response.writeHead(405, { Allow: "POST" });
      response.end();
      return;
    }

    try {
      await nodeHandler(request, response);
    } catch (error) {
      if (!response.headersSent) {
        response.writeHead(500, { "content-type": "application/json" });
        response.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null }));
      }
      console.error("MCP request failed", error);
    }
  });
}
