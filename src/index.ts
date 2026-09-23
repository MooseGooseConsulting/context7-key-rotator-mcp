import { Context7ApiClient } from "./context7-api.js";
import { createHttpMcpServer } from "./http-server.js";
import { RoundRobinKeyPool } from "./key-pool.js";
import { createLogger } from "./telemetry.js";

const port = Number.parseInt(process.env.PORT ?? "3000", 10);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("PORT must be a valid TCP port.");

const { logger, shutdown } = createLogger();
const api = new Context7ApiClient(RoundRobinKeyPool.fromEnvironment(), fetch, (message) => logger.warn({ event: "rotation" }, message));
const server = createHttpMcpServer(api, {
  record: (event) => logger.info(event, `${String(event.tool)} ${String(event.outcome)}`),
  logError: (message, error) => logger.error({ event: "server_error", err: error }, message),
});
server.listen(port, () => logger.info({ event: "startup", port, lokiPush: Boolean(process.env.TELEMETRY_LOKI_URL) }, `Context7 Key Rotator MCP listening on port ${port} at /mcp`));

// A rollout sends SIGTERM; without this the last Loki batch (up to 5 s of records) is lost.
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => {
    logger.info({ event: "shutdown", signal }, "Shutting down");
    server.close();
    server.closeIdleConnections();
    void shutdown().finally(() => process.exit(0));
  });
}
