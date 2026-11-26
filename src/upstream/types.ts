// From upstash/context7 packages/mcp/src/lib/types.ts at 6335fd8, MIT License,
// Copyright (c) 2021 Upstash, Inc.; see ./LICENSE.
export const CODE_OUTPUT_MODES = ["content", "files_with_matches", "count"] as const;

export type CodeOperation = "grep" | "list" | "read" | "definition" | "references" | "outline";

/** A GET /v2/code request, as the code tools (code-tools.ts) send it. Search fields follow ripgrep. */
export type CodeRequest = {
  libraryId: string;
  /** A git tag, or a commit from a result header. A version suffix on libraryId also works. */
  version?: string;
  operation?: CodeOperation;
  pattern?: string;
  fixed_strings?: boolean;
  ignore_case?: boolean;
  glob?: string | string[];
  path?: string;
  context?: number;
  before_context?: number;
  after_context?: number;
  word_regexp?: boolean;
  multiline?: boolean;
  multiline_dotall?: boolean;
  output_mode?: (typeof CODE_OUTPUT_MODES)[number];
  head_limit?: number;
  offset?: number;
};
