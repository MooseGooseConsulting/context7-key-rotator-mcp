// Tool names as upstash/context7 packages/mcp/src/lib/tool-names.ts at 6335fd8 defines them,
// MIT License, Copyright (c) 2021 Upstash, Inc.; see ./LICENSE. Only the tools this server
// serves: submit-docs-feedback is left out on purpose.
export const QUERY_DOCS_TOOL = "query-docs" as const;
export const RESOLVE_LIBRARY_ID_TOOL = "resolve-library-id" as const;
export const GREP_CODE_TOOL = "grep-code" as const;
export const GLOB_CODE_TOOL = "glob-code" as const;
export const READ_CODE_TOOL = "read-code" as const;
export const FIND_SYMBOL_TOOL = "find-symbol" as const;
export const GET_UPGRADE_GUIDE_TOOL = "get-upgrade-guide" as const;

export const CODE_TOOL_NAMES = [GREP_CODE_TOOL, GLOB_CODE_TOOL, READ_CODE_TOOL, FIND_SYMBOL_TOOL] as const;
export type CodeTool = (typeof CODE_TOOL_NAMES)[number];
