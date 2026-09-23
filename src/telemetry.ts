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

/** The build tag CI bakes into the image; the same value is the MCP serverInfo version. */
export function rotatorVersion(env: NodeJS.ProcessEnv = process.env): string {
  return env.ROTATOR_VERSION || "dev";
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
export type Telemetry = {
  logger: Logger;
  /** Flushes stdout and sends the last Loki batch; waits at most `timeoutMs`. */
  shutdown: (timeoutMs?: number) => Promise<void>;
};

/**
 * pino-loki options from the environment, or undefined when pushing is off or
 * TELEMETRY_LOKI_URL is not a URL. The endpoint is an absolute path, so any
 * path in TELEMETRY_LOKI_URL is replaced by it.
 */
export function lokiOptions(env: NodeJS.ProcessEnv = process.env): Record<string, unknown> | undefined {
  if (!env.TELEMETRY_LOKI_URL || !URL.canParse(env.TELEMETRY_LOKI_URL)) return undefined;
  return {
    host: env.TELEMETRY_LOKI_URL,
    endpoint: env.TELEMETRY_LOKI_ENDPOINT || "/insert/loki/api/v1/push?_msg_field=msg",
    basicAuth: env.TELEMETRY_LOKI_USERNAME
      ? { username: env.TELEMETRY_LOKI_USERNAME, password: env.TELEMETRY_LOKI_PASSWORD ?? "" }
      : undefined,
    labels: { job: "context7-key-rotator" },
    propsToLabels: ["event"],
    batching: { interval: 5 },
  };
}

export function createLogger(env: NodeJS.ProcessEnv = process.env): Telemetry {
  const base = { app: "context7-key-rotator", version: rotatorVersion(env) };
  const loki = lokiOptions(env);
  if (!loki) {
    const logger = pino({ base });
    if (env.TELEMETRY_LOKI_URL) logger.warn({ event: "telemetry" }, "TELEMETRY_LOKI_URL is not a URL; records go to stdout only");
    return { logger, shutdown: async () => logger.flush() };
  }

  const transport = pinoTransport({
    targets: [
      { target: "pino/file", options: { destination: 1 } },
      { target: "pino-loki", options: loki },
    ],
  });
  // pino treats a transport error as fatal; without a listener it would crash
  // the MCP server. Losing records is better than losing the tools.
  transport.on("error", (error: Error) => process.stderr.write(`Telemetry transport failed: ${error.message}\n`));
  const logger = pino({ base }, transport);
  return {
    logger,
    shutdown: (timeoutMs = 5_000) => new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, timeoutMs);
      transport.once("close", () => {
        clearTimeout(timer);
        resolve();
      });
      logger.flush();
      transport.end();
    }),
  };
}
