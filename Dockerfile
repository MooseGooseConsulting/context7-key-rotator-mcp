FROM node:22-bookworm-slim@sha256:de170b39439eb0e5a3444ad7d60b015614a381e10fecae2e30ec9e735122f38d AS build

WORKDIR /app
COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-bookworm-slim@sha256:de170b39439eb0e5a3444ad7d60b015614a381e10fecae2e30ec9e735122f38d

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
