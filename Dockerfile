FROM node:22-bookworm-slim@sha256:5ec23b7c622b00547753bc6ffd78085dd868a68aeb41c8e0a1418f033e13d96d AS build

WORKDIR /app
COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-bookworm-slim@sha256:5ec23b7c622b00547753bc6ffd78085dd868a68aeb41c8e0a1418f033e13d96d

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
