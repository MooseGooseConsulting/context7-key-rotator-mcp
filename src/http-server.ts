import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { Context7ApiClient } from "./context7-api.js";
import { createContext7McpServer, type ToolCallRecorder } from "./mcp-server.js";
import { requestContext } from "./telemetry.js";

export type HttpServerOptions = {
  /** Receives one event per tool call; see mcp-server.ts. */
  record?: ToolCallRecorder;
  /** Receives handler and adapter failures. */
  logError?: (message: string, error: unknown) => void;
};

export function createHttpMcpServer(api: Context7ApiClient, options: HttpServerOptions = {}): Server {
  const logError = options.logError ?? ((message, error) => console.error(message, error));
  const handler = createMcpHandler(() => createContext7McpServer(api, options.record), {
    keepAliveMs: 0,
    onerror: (error) => logError("MCP handler error", error),
  });
  const nodeHandler = toNodeHandler(handler, {
    onerror: (error) => logError("MCP node adapter error", error),
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

    const context = { requestId: randomUUID(), userAgent: request.headers["user-agent"], attempts: [] };
    await requestContext.run(context, async () => {
      try {
        await nodeHandler(request, response);
      } catch (error) {
        if (!response.headersSent) {
          response.writeHead(500, { "content-type": "application/json" });
          response.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null }));
        }
        logError("MCP request failed", error);
      }
    });
  });
}
