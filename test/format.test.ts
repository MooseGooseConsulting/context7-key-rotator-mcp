import { describe, expect, it } from "vitest";
import { formatSearchResults } from "../src/format.js";

describe("formatSearchResults", () => {
  it("matches the native Context7 library listing shape", () => {
    expect(formatSearchResults({
      searchFilterApplied: true,
      results: [{
        id: "/prefecthq/fastmcp/v3.4.5",
        title: "FastMCP",
        description: "A Python framework for MCP servers.",
        totalSnippets: 42,
        trustScore: 9,
        benchmarkScore: 88.5,
        versions: ["v3.4.5"],
      }],
    })).toBe("**Note:** Your results only include libraries matching your teamspace's library filters. To adjust quality thresholds or blocked libraries, update your filters at https://context7.com/dashboard?tab=policies\n\n- Title: FastMCP\n- Context7-compatible library ID: /prefecthq/fastmcp/v3.4.5\n- Description: A Python framework for MCP servers.\n- Code Snippets: 42\n- Source Reputation: High\n- Benchmark Score: 88.5\n- Versions: v3.4.5");
  });
});
