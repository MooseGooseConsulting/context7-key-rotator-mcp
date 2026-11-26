// How upstash/context7 packages/mcp/src/lib/api.ts at 6335fd8 turns /v2/code and
// /v2/version-upgrade-guide responses into tool answers. MIT License, Copyright (c) 2021
// Upstash, Inc.; see ./LICENSE. Changes: these take the status and body this server's client
// already read instead of a fetch Response, and drop the OAuth sign-in branch.
import type { CodeRequest } from "./types.js";

type ErrorJson = { error?: string; message?: string } | undefined;

export function parseJson<T>(text: string): T | undefined {
  try {
    return JSON.parse(text) as T;
  } catch {
    return undefined;
  }
}

/** Upstream's parseErrorResponse, for a configured key: the API's message, else one per status. */
export function errorText(status: number, json: ErrorJson): string {
  if (json?.message) return json.message;
  if (status === 429) return "Rate limited or quota exceeded. Upgrade your plan at https://context7.com/plans for higher limits.";
  if (status === 404) return "The library you are trying to access does not exist. Please try with a different library ID.";
  if (status === 401) return "Invalid API key. Please check your API key. API keys should start with 'ctx7sk' prefix.";
  return `Request failed with status ${status}. Please try again later.`;
}

/** A sentence of the server's 202 message that tells the agent to wait and call again. */
const WAIT_ADVICE = /\b(call again|keep calling|meanwhile)\b/i;

/**
 * The answer while a library's source is being indexed. The code tools never make the agent
 * wait: an index can take minutes, or stall, and the user's session must go on. So the server's
 * own "keep calling" advice is dropped, and the agent answers from query-docs now.
 */
export function indexingAnswer(message: string | undefined, tool: string): string {
  const base = (message ?? "The library source is being indexed.")
    .split(/(?<=\.)\s+/)
    .filter((sentence) => !WAIT_ADVICE.test(sentence))
    .join(" ");
  return `${base} This is not an error. Until the index is done, every code tool call for this version gives this answer, so do not try other patterns or files and do not wait: answer from query-docs now. Only if the source is still needed at the end of the task, call ${tool} once more.`;
}

/**
 * The summary line of an empty /v2/code result, such as "0 matching lines in 0 files",
 * "0 entries in src" or "Symbols in a.ts (0 of 0):".
 */
const EMPTY_CODE_SUMMARY = /^(?:(?:at least )?0 |(?:Symbols in .+|Exported API) \(0 of )/;

/** True when the result's summary line counts no results. Library source lines are not checked. */
export function isEmptyCodeResult(text: string): boolean {
  const [first = "", second = ""] = text.split("\n", 2);
  return EMPTY_CODE_SUMMARY.test(first.startsWith("Library: ") ? second : first);
}

/**
 * The error text for a failed /v2/code call. The next step comes from the
 * HTTP status and the error code in the JSON body, not from the message text.
 */
export function codeErrorMessage(status: number, body: string, request: CodeRequest, tool: string): string {
  const json = parseJson<{ error?: string; message?: string }>(body);
  const code = typeof json?.error === "string" ? json.error : undefined;
  // A gateway error has no body from the code API: write the whole message here.
  if (!json?.message && status >= 500)
    return `Source code search is not available now (HTTP ${status}). Do not retry now: answer from query-docs.`;
  const message = errorText(status, json);
  // For a git tag, index_failed means that the tag may not exist; the message lists the docs versions.
  const hasVersion = !!request.version || request.libraryId.split("/").filter(Boolean).length > 2;
  if (code === "index_failed" && hasVersion)
    return `${message} Call ${tool} again with one of the docs versions in this message, or without version.`;
  if (code === "code_search_unavailable") return `${message} Answer from query-docs.`;
  return message;
}

/**
 * The upgrade guide endpoint's error codes that answer the agent's request, not failures: a
 * library without a guide or an unknown version, a page past the last, or a guide that cannot
 * be prepared for now. The agent sees the API's message, which says what to do next.
 */
const UPGRADE_GUIDE_ANSWERS = new Set(["library_not_prepared", "version_not_found", "page_out_of_range", "guide_unavailable"]);

/** The API's message for an error response that answers the request, or undefined. */
export function upgradeGuideAnswer(body: string): string | undefined {
  const json = parseJson<{ error?: string; message?: string }>(body);
  const error = json?.error;
  if (!error || !UPGRADE_GUIDE_ANSWERS.has(error)) return undefined;
  return json?.message ?? error;
}
