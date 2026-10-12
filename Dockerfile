FROM node:22-bookworm-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392 AS build

WORKDIR /app
COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-bookworm-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392

ENV NODE_ENV=production
ENV PORT=3000
WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist

# Set by the publish workflow to the build's sortable tag; reported as the MCP
# serverInfo version so a client can see which build is serving it.
ARG ROTATOR_VERSION=dev
ENV ROTATOR_VERSION=$ROTATOR_VERSION

USER node
EXPOSE 3000
ENTRYPOINT ["node", "dist/index.js"]
