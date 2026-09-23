import { AsyncLocalStorage } from "node:async_hooks";
import { pino, transport as pinoTransport, type Logger } from "pino";

/** One upstream Context7 call made while serving a tool call. */
export type UpstreamAttempt = {
  slot: number;
  endpoint: "search" | "context";
  status: number | "network_error";
  code?: string;
  durationMs: number;
  rateLimitRemaining?: number;
  rateLimitLimit?: number;
};

/** What is known about the MCP request being served, shared with the API client. */
export type RequestContext = {
  requestId: string;
  userAgent?: string;
  attempts: UpstreamAttempt[];
  redirectedTo?: string;
};

export const requestContext = new AsyncLocalStorage<RequestContext>();

export function recordAttempt(attempt: UpstreamAttempt): void {
  requestContext.getStore()?.attempts.push(attempt);
}

export function noteRedirect(libraryId: string): void {
  const store = requestContext.getStore();
  if (store) store.redirectedTo = libraryId;
}

/**
 * JSON lines on stdout always. When TELEMETRY_LOKI_URL is set, the same lines
 * are also pushed in batches to a Loki-compatible endpoint (VictoriaLogs via
 * vmauth in the homelab) with basic auth from TELEMETRY_LOKI_USERNAME and
 * TELEMETRY_LOKI_PASSWORD. A private CA is trusted through NODE_EXTRA_CA_CERTS.
 */
export function createLogger(env: NodeJS.ProcessEnv = process.env): Logger {
  const base = { app: "context7-key-rotator", version: env.ROTATOR_VERSION || "dev" };
  if (!env.TELEMETRY_LOKI_URL) return pino({ base });

  const transport = pinoTransport({
    targets: [
      { target: "pino/file", options: { destination: 1 } },
      {
        target: "pino-loki",
        options: {
          host: env.TELEMETRY_LOKI_URL,
          endpoint: env.TELEMETRY_LOKI_ENDPOINT || "/insert/loki/api/v1/push?_msg_field=msg",
          basicAuth: env.TELEMETRY_LOKI_USERNAME
            ? { username: env.TELEMETRY_LOKI_USERNAME, password: env.TELEMETRY_LOKI_PASSWORD ?? "" }
            : undefined,
          labels: { job: "context7-key-rotator" },
          propsToLabels: ["event"],
          batching: { interval: 5 },
        },
      },
    ],
  });
  return pino({ base }, transport);
}
