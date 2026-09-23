import { Context7ApiClient } from "./context7-api.js";
import { createHttpMcpServer } from "./http-server.js";
import { RoundRobinKeyPool } from "./key-pool.js";
import { createLogger, lokiOptions } from "./telemetry.js";

const port = Number.parseInt(process.env.PORT ?? "3000", 10);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("PORT must be a valid TCP port.");

// Together these stay under Kubernetes' default 30-second termination grace period.
const DRAIN_MS = 20_000;
const TELEMETRY_FLUSH_MS = 5_000;

const { logger, shutdown } = createLogger();
const api = new Context7ApiClient(RoundRobinKeyPool.fromEnvironment(), fetch, (message) => logger.warn({ event: "rotation" }, message));
const server = createHttpMcpServer(api, {
  record: (event) => logger.info(event, `${String(event.tool)} ${String(event.outcome)}`),
  logError: (message, error) => logger.error({ event: "server_error", err: error }, message),
});
server.listen(port, () => logger.info({ event: "startup", port, lokiPush: Boolean(lokiOptions()) }, `Context7 Key Rotator MCP listening on port ${port} at /mcp`));

// A rollout sends SIGTERM. Stop taking requests, let calls in progress finish
// and write their records, then send the last Loki batch (up to 5 s of records).
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => {
    logger.info({ event: "shutdown", signal }, "Shutting down");
    const drained = new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, DRAIN_MS);
      server.close(() => {
        clearTimeout(timer);
        resolve();
      });
      server.closeIdleConnections();
    });
    void drained.then(() => shutdown(TELEMETRY_FLUSH_MS)).finally(() => process.exit(0));
  });
}
