import { Context7ApiClient } from "./context7-api.js";
import { createHttpMcpServer } from "./http-server.js";
import { RoundRobinKeyPool } from "./key-pool.js";

const port = Number.parseInt(process.env.PORT ?? "3000", 10);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("PORT must be a valid TCP port.");

const api = new Context7ApiClient(RoundRobinKeyPool.fromEnvironment());
const server = createHttpMcpServer(api);
server.listen(port, () => console.error(`Context7 Key Rotator MCP listening on port ${port} at /mcp`));
