import type { SearchResponse, SearchResult, SlotUsage } from "./context7-api.js";

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

const num = (value: unknown): number | undefined => typeof value === "number" && Number.isFinite(value) ? value : undefined;
const obj = (value: unknown): Record<string, unknown> => value && typeof value === "object" ? value as Record<string, unknown> : {};

/**
 * One block per key, by slot index (never the key), from `GET /api/v2/usage`:
 * the key's requests this month against its plan allowance, and any paid extra
 * requests for its teamspace. An unexpected shape is shown as JSON.
 */
export function formatUsage(slots: SlotUsage[]): string {
  return slots.map(({ slot, usage, error }) => {
    if (!usage) return `Key slot ${slot}: usage unavailable: ${error ?? "no answer"}`;
    const member = obj(usage.member);
    const teamspace = obj(usage.teamspace);
    const used = num(member.requests);
    const included = num(member.includedInPlan);
    if (used === undefined || included === undefined) return `Key slot ${slot}: ${JSON.stringify(usage).slice(0, 1000)}`;
    const lines = [
      `Key slot ${slot}${typeof usage.plan === "string" ? ` (${usage.plan} plan)` : ""}:`,
      `- Requests this month: ${used} of ${included} (${Math.max(0, included - used)} left)`,
    ];
    if (typeof usage.usageResetsAt === "string") lines.push(`- Resets: ${usage.usageResetsAt}`);
    const extra = num(teamspace.extraRequests);
    if (extra) {
      const cost = num(teamspace.extraCostUsd);
      const limit = num(teamspace.spendingLimitUsd);
      const money = cost === undefined ? "" : ` ($${cost.toFixed(2)}${limit === undefined ? "" : ` of a $${limit.toFixed(2)} limit`})`;
      lines.push(`- Extra paid requests: ${extra}${money}`);
    }
    return lines.join("\n");
  }).join("\n\n");
}
