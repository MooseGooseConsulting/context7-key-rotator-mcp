import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { Context7ApiClient, Context7ApiError, DOCS_NOT_FOUND } from "./context7-api.js";
import { formatSearchResults, formatUsage } from "./format.js";
import { type RequestContext, requestContext, rotatorVersion } from "./telemetry.js";
import { codeErrorMessage, errorText, indexingAnswer, isEmptyCodeResult, parseJson, upgradeGuideAnswer } from "./upstream/answers.js";
import { CODE_TOOLS_INSTRUCTIONS, type CodeToolRunner, registerCodeTools, rewriteCodeHints } from "./upstream/code-tools.js";
import { aliasArgs, GLOBAL_ALIASES, QUERY_DOCS_ALIASES } from "./upstream/tool-args.js";
import { GET_UPGRADE_GUIDE_TOOL } from "./upstream/tool-names.js";
import { preparingNote, UPGRADE_GUIDE_DESCRIPTION, upgradeGuideSchema } from "./upstream/upgrade-guide.js";

/** Upstream's server instructions (index.ts at 6335fd8) with the code tools on. */
const INSTRUCTIONS = `Use this server to fetch current documentation whenever the user asks about a library, framework, SDK, API, CLI tool, or cloud service — even well-known ones like React, Next.js, Prisma, Express, Tailwind, Django, or Spring Boot. This includes API syntax, configuration, version migration, porting code between libraries, platforms, or SQL dialects, library-specific debugging, setup instructions, and CLI tool usage. Use even when you think you know the answer — your training data may not reflect recent changes. Prefer this over web search for library docs.

Do not use for: refactoring, debugging, or reviewing code that does not depend on a library or platform API, or general programming concepts.

${CODE_TOOLS_INSTRUCTIONS}`;

const answerText = (value: string) => ({ content: [{ type: "text" as const, text: value }] });

const resolveSchema = z.object({
  query: z.string().min(1).describe("What to look up in the library's documentation. This is used to rank library results by relevance to what the user is trying to accomplish. The query is sent to the Context7 API for processing. Do not include any sensitive or confidential information such as API keys, passwords, credentials, personal data, or proprietary code in your query."),
  libraryName: z.string().min(1).describe("Library name to search for and retrieve a Context7-compatible library ID. Use the official library name with proper punctuation — e.g., 'Next.js' instead of 'nextjs', 'Customer.io' instead of 'customerio', 'Three.js' instead of 'threejs'."),
});

const docsSchema = z.object({
  libraryId: z.string().min(1).describe("Exact Context7-compatible library ID (e.g., '/mongodb/docs', '/vercel/next.js', '/supabase/supabase', '/vercel/next.js/v14.3.0-canary.87') retrieved from 'resolve-library-id' or directly from user query in the format '/org/project' or '/org/project/version'."),
  query: z.string().min(1).describe("What to look up in the library's documentation, scoped to a single concept. Be specific and include relevant details, but keep each query to one topic — if the user's question spans multiple distinct concepts, make a separate call per concept instead of combining them, unless the question is about how the concepts interact. Good: 'How to set up authentication with JWT in Express.js' or 'React useEffect cleanup function examples'. Bad (too vague): 'auth' or 'hooks'. Bad (too broad): 'routing and auth and caching in Next.js'. The query is sent to the Context7 API for processing. Do not include any sensitive or confidential information such as API keys, passwords, credentials, personal data, or proprietary code in your query."),
  // No length limit here: the API trims long values instead of rejecting the call.
  language: z.string().optional().describe("Programming language the user is writing code in, such as 'Python', 'TypeScript', 'Go', or 'C#'. Ranks code examples in that language first. Leave it out when the language is unknown or does not apply."),
  version: z.string().optional().describe("Version of the library the user's project uses or the question names, as written there, such as '15.4.3', '^15.4.3' or '14'. Pass it here, not as a suffix of libraryId. Leave it out for the latest documentation."),
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
  args: Record<string, unknown>,
  run: () => Promise<{ result: ToolResult; resultCount?: number; outcome?: string }>,
): Promise<ToolResult> {
  // A fresh context per tool call, so a request that carries several calls
  // does not credit one call with another's upstream attempts.
  const parent = requestContext.getStore();
  const context: RequestContext = { requestId: parent?.requestId, userAgent: parent?.userAgent, attempts: [] };
  return requestContext.run(context, () => observe(record, tool, args, run));
}

async function observe(
  record: ToolCallRecorder,
  tool: string,
  args: Record<string, unknown>,
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

/** The failure's message (Context7's own for an API error), truncated. */
function errorMessage(failure: unknown): string | undefined {
  if (failure === undefined) return undefined;
  if (failure instanceof Context7ApiError && failure.code) {
    // A code or upgrade-guide failure already carries the cleaned-up text, not the JSON body.
    return (parseMessage(failure.message) ?? failure.message).slice(0, 300);
  }
  return String(failure instanceof Error ? failure.message : failure).slice(0, 500);
}

/** The `message` field of a Context7 JSON error body. */
function parseMessage(body: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(body);
    return parsed && typeof parsed === "object" && typeof (parsed as { message?: unknown }).message === "string"
      ? (parsed as { message: string }).message
      : undefined;
  } catch {
    return undefined;
  }
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
  }, { instructions: INSTRUCTIONS });

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
- Source code: present when 'grep-code', 'glob-code', 'read-code' and 'find-symbol' can usually search the library's source. '/websites/...' and '/llmstxt/...' IDs have docs only.

For best results, select libraries based on name match, source reputation, snippet coverage, benchmark score, and relevance to your use case.

IMPORTANT: Do not call this tool more than 3 times per question. If you cannot find what you need after 3 calls, use the best result you have.`,
      inputSchema: z.preprocess(aliasArgs(GLOBAL_ALIASES), resolveSchema),
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

Do not call this tool more than 3 times per question.

If you know the programming language the user is working in, pass it as \`language\` so the results match their setup.

If the user's project or question names a version of the library (package.json, a lockfile, "Next.js 14"), pass it as \`version\`. Context7 serves that version's documentation, or the closest version it has, and says which one it served.`,
      inputSchema: z.preprocess(aliasArgs({ ...GLOBAL_ALIASES, ...QUERY_DOCS_ALIASES }), docsSchema),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true, idempotentHint: true },
    },
    async ({ libraryId, query, language, version }) =>
      observed(record, "query-docs", { libraryId, query, language, version }, async () => {
        const text = await api.fetchLibraryContext(query, libraryId, { language, version });
        return {
          result: { content: [{ type: "text" as const, text }] },
          outcome: text.endsWith(DOCS_NOT_FOUND) ? "empty" : undefined,
        };
      }),
  );

  server.registerTool(
    GET_UPGRADE_GUIDE_TOOL,
    {
      title: "Get Upgrade Guide",
      description: UPGRADE_GUIDE_DESCRIPTION,
      inputSchema: upgradeGuideSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true, idempotentHint: true },
    },
    async (request) =>
      observed(record, GET_UPGRADE_GUIDE_TOOL, { ...request }, async () => {
        let reply;
        try {
          reply = await api.fetchUpgradeGuide(request);
        } catch (error) {
          if (!(error instanceof Context7ApiError)) throw error;
          // No guide, an unknown version, a page past the last or "not now" is an answer.
          const answer = upgradeGuideAnswer(error.message);
          if (answer) return { result: answerText(answer), outcome: "empty" };
          const message = error.status === 404
            ? "The upgrade guide service is not available (HTTP 404). Please try again later."
            : errorText(error.status, parseJson(error.message));
          throw new Context7ApiError(message, error.status, undefined, error.code);
        }
        if (reply.status === 202) return { result: answerText(preparingNote(parseJson(reply.text))), outcome: "preparing" };
        if (!reply.text) return { result: answerText("No upgrade guide was returned for these versions."), outcome: "empty" };
        return { result: answerText(reply.text) };
      }),
  );

  const runCode: CodeToolRunner = (tool, request) =>
    observed(record, tool, typeof request === "string" ? {} : { ...request }, async () => {
      // A usage error from the argument mapping (for example glob and type together).
      if (typeof request === "string") return { result: { ...answerText(request), isError: true }, outcome: "invalid" };
      let reply;
      try {
        reply = await api.fetchCode(request);
      } catch (error) {
        if (!(error instanceof Context7ApiError)) throw error;
        throw new Context7ApiError(codeErrorMessage(error.status, error.message, request, tool), error.status, undefined, error.code);
      }
      // Still indexing is a normal answer: the agent answers from query-docs meanwhile.
      if (reply.status === 202) {
        return { result: answerText(indexingAnswer(parseJson<{ message?: string }>(reply.text)?.message, tool)), outcome: "indexing" };
      }
      if (!reply.text) return { result: answerText("No source results for this query."), outcome: "empty" };
      return { result: answerText(rewriteCodeHints(reply.text)), outcome: isEmptyCodeResult(reply.text) ? "empty" : undefined };
    });
  registerCodeTools(server, runCode);

  server.registerTool(
    "context7-usage",
    {
      title: "Context7 Usage",
      description: `Reports how many Context7 requests each of this server's API keys has used this month, how many its plan includes, when the count resets, and which experimental tools (code search, upgrade guide) each key's teamspace has turned on. Call it only when the user asks about Context7 usage or quota; it is not needed before looking up documentation.`,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true, idempotentHint: true },
    },
    async () =>
      observed(record, "context7-usage", {}, async () => {
        const slots = await api.usage();
        const failed = slots.every((slot) => !slot.usage);
        return {
          result: { content: [{ type: "text" as const, text: formatUsage(slots) }], ...(failed ? { isError: true } : {}) },
          resultCount: slots.filter((slot) => slot.usage).length,
        };
      }),
  );

  return server;
}
