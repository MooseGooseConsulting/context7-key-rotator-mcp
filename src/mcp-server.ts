import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { Context7ApiClient, Context7ApiError } from "./context7-api.js";
import { formatSearchResults } from "./format.js";

const resolveSchema = z.object({
  query: z.string().min(1).describe("What to look up in the library's documentation. This is used to rank library results by relevance to what the user is trying to accomplish. The query is sent to the Context7 API for processing. Do not include any sensitive or confidential information such as API keys, passwords, credentials, personal data, or proprietary code in your query."),
  libraryName: z.string().min(1).describe("Library name to search for and retrieve a Context7-compatible library ID. Use the official library name with proper punctuation — e.g., 'Next.js' instead of 'nextjs', 'Customer.io' instead of 'customerio', 'Three.js' instead of 'threejs'."),
});

const docsSchema = z.object({
  libraryId: z.string().min(1).describe("Exact Context7-compatible library ID (e.g., '/mongodb/docs', '/vercel/next.js', '/supabase/supabase', '/vercel/next.js/v14.3.0-canary.87') retrieved from 'resolve-library-id' or directly from user query in the format '/org/project' or '/org/project/version'."),
  query: z.string().min(1).describe("What to look up in the library's documentation, scoped to a single concept. Be specific and include relevant details, but keep each query to one topic — if the user's question spans multiple distinct concepts, make a separate call per concept instead of combining them, unless the question is about how the concepts interact. Good: 'How to set up authentication with JWT in Express.js' or 'React useEffect cleanup function examples'. Bad (too vague): 'auth' or 'hooks'. Bad (too broad): 'routing and auth and caching in Next.js'. The query is sent to the Context7 API for processing. Do not include any sensitive or confidential information such as API keys, passwords, credentials, personal data, or proprietary code in your query."),
});

function toolError(error: unknown) {
  const message = error instanceof Context7ApiError
    ? error.message
    : `Context7 request failed: ${error instanceof Error ? error.message : String(error)}`;
  return { content: [{ type: "text" as const, text: message }], isError: true };
}

export function createContext7McpServer(api: Context7ApiClient): McpServer {
  const server = new McpServer({
    name: "Context7 Key Rotator",
    version: "0.1.0",
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
    async ({ libraryName, query }) => {
      try {
        const response = await api.searchLibraries(query, libraryName);
        return { content: [{ type: "text" as const, text: `Available Libraries:\n\n${formatSearchResults(response)}` }] };
      } catch (error) {
        return toolError(error);
      }
    },
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
    async ({ libraryId, query }) => {
      try {
        return { content: [{ type: "text" as const, text: await api.fetchLibraryContext(query, libraryId) }] };
      } catch (error) {
        return toolError(error);
      }
    },
  );

  return server;
}
