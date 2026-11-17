FROM node:26-bookworm-slim@sha256:5df79989ed685e09f0a98019db4cebfb22fb9df1a53c0161664a011f7ff6b0f1 AS build

WORKDIR /app
COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:26-bookworm-slim@sha256:5df79989ed685e09f0a98019db4cebfb22fb9df1a53c0161664a011f7ff6b0f1

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
