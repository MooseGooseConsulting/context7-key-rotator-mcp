import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { fileURLToPath } from "node:url";
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
  /** The bundled installer served at GET /install.mjs; `npm run build:installer` writes it. */
  installerPath?: string;
};

const DEFAULT_INSTALLER = fileURLToPath(new URL("../dist-installer/install.mjs", import.meta.url));

async function readInstaller(path = DEFAULT_INSTALLER): Promise<Buffer | undefined> {
  try {
    return await readFile(path);
  } catch {
    return undefined;
  }
}

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
    // The client installer, built into the image with this server, so the entry and skill it
    // installs always match the tools this build serves. See installer/README.md.
    if (requestUrl.pathname === "/install.mjs" && request.method === "GET") {
      const installer = await readInstaller(options.installerPath);
      response.writeHead(installer ? 200 : 404, { "content-type": installer ? "text/javascript; charset=utf-8" : "application/json", "cache-control": "no-store" });
      response.end(installer ?? JSON.stringify({ error: "not_found", message: "This build has no installer." }));
      return;
    }
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
