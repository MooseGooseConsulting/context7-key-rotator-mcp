import type { SearchResponse, SearchResult } from "./context7-api.js";

function reputationLabel(score: number | undefined): "High" | "Medium" | "Low" | "Unknown" {
  if (score === undefined || score < 0) return "Unknown";
  if (score >= 7) return "High";
  if (score >= 4) return "Medium";
  return "Low";
}

function formatSearchResult(result: SearchResult): string {
  const lines = [
    `- Title: ${result.title}`,
    `- Context7-compatible library ID: ${result.id}`,
    `- Description: ${result.description}`,
  ];

  if (result.totalSnippets !== undefined && result.totalSnippets !== -1) lines.push(`- Code Snippets: ${result.totalSnippets}`);
  lines.push(`- Source Reputation: ${reputationLabel(result.trustScore)}`);
  if (result.benchmarkScore !== undefined && result.benchmarkScore > 0) lines.push(`- Benchmark Score: ${result.benchmarkScore}`);
  if (result.versions?.length) lines.push(`- Versions: ${result.versions.join(", ")}`);
  if (result.source) lines.push(`- Source: ${result.source}`);
  return lines.join("\n");
}

export function formatSearchResults(response: SearchResponse): string {
  if (!response.results?.length) return "No documentation libraries found matching your query.";

  const parts: string[] = [];
  if (response.searchFilterApplied) {
    parts.push("**Note:** Your results only include libraries matching your teamspace's library filters. To adjust quality thresholds or blocked libraries, update your filters at https://context7.com/dashboard?tab=policies");
  }
  parts.push(response.results.map(formatSearchResult).join("\n----------\n"));
  return parts.join("\n\n");
}
