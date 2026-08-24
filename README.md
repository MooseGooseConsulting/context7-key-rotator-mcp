# Context7 Key Rotator MCP

A small, standalone remote HTTP [Model Context Protocol](https://modelcontextprotocol.io/) server for Context7 V2. It exposes exactly two tools:

- `resolve-library-id(libraryName, query)`
- `query-docs(libraryId, query)`

Each ordinary request alternates between the two keys in `CONTEXT7_API_KEYS`. If Context7 blocks the selected key (`401`, `403`, or `429`), the server retries the request once with the other key. If both keys are blocked, the tool call returns an MCP error.

The server is stateless: it has no OAuth, CLI adapter, persistent key state, cooldowns, scoring, proxying, or session storage.

## Run locally

`CONTEXT7_API_KEYS` must contain exactly two comma-separated Context7 API keys. Keep it in your secret manager; do not place it in a checked-in `.env` file.

```powershell
doppler run -p ai-automation -c dev -- npm start
```

The server listens on `PORT` (default `3000`) at `POST /mcp`. The hosting environment is responsible for network exposure, TLS, and client registration.

## Development

```powershell
npm install
npm test
npm run build
```

The tests mock Context7 V2 and cover normal alternation, retrying the other key after a blocked response, failure when both keys are blocked, and the native-compatible result formatter.
