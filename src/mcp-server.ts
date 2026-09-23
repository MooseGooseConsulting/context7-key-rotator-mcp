import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { Context7ApiClient, Context7ApiError, DOCS_NOT_FOUND } from "./context7-api.js";
import { formatSearchResults } from "./format.js";
import { type RequestContext, requestContext, rotatorVersion } from "./telemetry.js";

const resolveSchema = z.object({
  query: z.string().min(1).describe("What to look up in the library's documentation. This is used to rank library results by relevance to what the user is trying to accomplish. The query is sent to the Context7 API for processing. Do not include any sensitive or confidential information such as API keys, passwords, credentials, personal data, or proprietary code in your query."),
  libraryName: z.string().min(1).describe("Library name to search for and retrieve a Context7-compatible library ID. Use the official library name with proper punctuation — e.g., 'Next.js' instead of 'nextjs', 'Customer.io' instead of 'customerio', 'Three.js' instead of 'threejs'."),
});

const docsSchema = z.object({
  libraryId: z.string().min(1).describe("Exact Context7-compatible library ID (e.g., '/mongodb/docs', '/vercel/next.js', '/supabase/supabase', '/vercel/next.js/v14.3.0-canary.87') retrieved from 'resolve-library-id' or directly from user query in the format '/org/project' or '/org/project/version'."),
  query: z.string().min(1).describe("What to look up in the library's documentation, scoped to a single concept. Be specific and include relevant details, but keep each query to one topic — if the user's question spans multiple distinct concepts, make a separate call per concept instead of combining them, unless the question is about how the concepts interact. Good: 'How to set up authentication with JWT in Express.js' or 'React useEffect cleanup function examples'. Bad (too vague): 'auth' or 'hooks'. Bad (too broad): 'routing and auth and caching in Next.js'. The query is sent to the Context7 API for processing. Do not include any sensitive or confidential information such as API keys, passwords, credentials, personal data, or proprietary code in your query."),
});

/** Where each finished tool call is recorded; index.ts sends it to the logger. */
export type ToolCallRecorder = (event: Record<string, unknown>) => void;

type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

/**
 * Runs a tool call and records one event for it: who called (user agent), the
 * arguments, the outcome, and every upstream Context7 attempt made to serve it.
 */
async function observed(
  record: ToolCallRecorder,
  tool: string,
  args: Record<string, string>,
  run: () => Promise<{ result: ToolResult; resultCount?: number; outcome?: string }>,
): Promise<ToolResult> {
  // A fresh context per tool call, so a request that carries several calls
  // does not credit one call with another's upstream attempts.
  const parent = requestContext.getStore();
  const context: RequestContext = { requestId: parent?.requestId ?? "", userAgent: parent?.userAgent, attempts: [] };
  return requestContext.run(context, () => observe(record, tool, args, run));
}

async function observe(
  record: ToolCallRecorder,
  tool: string,
  args: Record<string, string>,
  run: () => Promise<{ result: ToolResult; resultCount?: number; outcome?: string }>,
): Promise<ToolResult> {
  const started = performance.now();
  let outcome: { result: ToolResult; resultCount?: number; outcome?: string };
  let failure: unknown;
  try {
    outcome = await run();
  } catch (error) {
    failure = error;
    outcome = { result: toolError(error) };
  }
  const context = requestContext.getStore();
  const event = {
    event: "tool_call",
    requestId: context?.requestId,
    userAgent: context?.userAgent,
    tool,
    ...args,
    outcome: outcome.result.isError ? "error" : outcome.outcome ?? "ok",
    errorStatus: failure instanceof Context7ApiError ? failure.status : undefined,
    errorCode: failure instanceof Context7ApiError ? failure.code : undefined,
    errorMessage: errorMessage(failure),
    resultCount: outcome.resultCount,
    responseChars: outcome.result.content.reduce((total, part) => total + part.text.length, 0),
    redirectedTo: context?.redirectedTo,
    upstreamCalls: context?.attempts.length,
    attempts: context?.attempts,
    durationMs: Math.round(performance.now() - started),
  };
  try {
    record(event);
  } catch {
    // A broken recorder must not turn a served tool call into an error.
  }
  return outcome.result;
}

/** Context7's own message when it gave no error code, truncated; otherwise the code says enough. */
function errorMessage(failure: unknown): string | undefined {
  if (failure === undefined) return undefined;
  if (failure instanceof Context7ApiError && failure.code) return undefined;
  return String(failure instanceof Error ? failure.message : failure).slice(0, 500);
}

function toolError(error: unknown) {
  const message = error instanceof Context7ApiError
    ? error.message
    : `Context7 request failed: ${error instanceof Error ? error.message : String(error)}`;
  return { content: [{ type: "text" as const, text: message }], isError: true };
}

export function createContext7McpServer(api: Context7ApiClient, record: ToolCallRecorder = () => {}): McpServer {
  const server = new McpServer({
    name: "Context7 Key Rotator",
    version: rotatorVersion(),
    websiteUrl: "https://context7.com",
    description: "Context7 V2 documentation lookup with balanced upstream API keys.",
  });

  server.registerTool(
    "resolve-library-id",
    {
      title: "Resolve Context7 Library ID",
      description: `Resolves a package/product name to a Context7-compatible library ID and returns matching libraries.

You MUST call this function before 'Query Documentation' tool to obtain a valid Context7-compatible library ID UNLESS the user explicitly provides a library ID in the format '/org/project' or '/org/project/version' in their query.

Each result includes:
- Library ID: Context7-compatible identifier (format: /org/project)
- Name: Library or package name
- Description: Short summary
- Code Snippets: Number of available code examples
- Source Reputation: Authority indicator (High, Medium, Low, or Unknown)
- Benchmark Score: Quality indicator (100 is the highest score)
- Versions: List of versions if available. Use one of those versions if the user provides a version in their query. The format of the version is /org/project/version.

For best results, select libraries based on name match, source reputation, snippet coverage, benchmark score, and relevance to your use case.

IMPORTANT: Do not call this tool more than 3 times per question. If you cannot find what you need after 3 calls, use the best result you have.`,
      inputSchema: resolveSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true, idempotentHint: true },
    },
    async ({ libraryName, query }) =>
      observed(record, "resolve-library-id", { libraryName, query }, async () => {
        const response = await api.searchLibraries(query, libraryName);
        return {
          result: { content: [{ type: "text" as const, text: `Available Libraries:\n\n${formatSearchResults(response)}` }] },
          resultCount: response.results?.length ?? 0,
        };
      }),
  );

  server.registerTool(
    "query-docs",
    {
      title: "Query Documentation",
      description: `Retrieves and queries up-to-date documentation and code examples from Context7 for any programming library or framework.

You must call 'Resolve Context7 Library ID' tool first to obtain the exact Context7-compatible library ID required to use this tool, UNLESS the user explicitly provides a library ID in the format '/org/project' or '/org/project/version' in their query.

Do not call this tool more than 3 times per question.`,
      inputSchema: docsSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true, idempotentHint: true },
    },
    async ({ libraryId, query }) =>
      observed(record, "query-docs", { libraryId, query }, async () => {
        const text = await api.fetchLibraryContext(query, libraryId);
        return {
          result: { content: [{ type: "text" as const, text }] },
          outcome: text.endsWith(DOCS_NOT_FOUND) ? "empty" : undefined,
        };
      }),
  );

  return server;
}
