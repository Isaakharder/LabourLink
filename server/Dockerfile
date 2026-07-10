# Build context must be the repo root (not server/) because the
# tsconfig.json here uses rootDir: ".." to compile server/src alongside
# ../shared — both the dev and build stages need shared/ as a sibling
# directory to reproduce that relationship inside the image.

# ---- base: install server deps once, reused by the dev stage ----
FROM node:20-alpine AS base
WORKDIR /app
COPY server/package*.json ./
RUN npm ci

# ---- dev: hot reload via nodemon/ts-node, source is bind-mounted at runtime ----
FROM base AS dev
COPY server/. .
EXPOSE 4000
CMD ["npm", "run", "dev"]

# ---- build: compile TypeScript (server/src + ../shared) ----
FROM node:20-alpine AS build
WORKDIR /build
COPY shared/ shared/
COPY server/package*.json server/
RUN npm ci --prefix server
COPY server/ server/
WORKDIR /build/server
RUN npm run build

# ---- prod: minimal runtime image, no dev tooling ----
FROM node:20-alpine AS prod
WORKDIR /app
ENV NODE_ENV=production
COPY server/package*.json ./
RUN npm ci --omit=dev
COPY --from=build /build/server/dist ./dist
COPY database/migrations ./database/migrations
ENV MIGRATIONS_DIR=/app/database/migrations
EXPOSE 4000
USER node
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=5 \
  CMD wget -qO- http://127.0.0.1:4000/health || exit 1
CMD ["node", "dist/server/src/index.js"]
