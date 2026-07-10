# Build context must be the repo root (not web/) so the prod build stage
# can see shared/ (Vite alias '@shared' -> ../shared) as a sibling directory,
# matching the dev bind-mount layout.

# ---- base: install web deps once, reused by the dev stage ----
FROM node:20-alpine AS base
WORKDIR /app
COPY web/package*.json ./
RUN npm ci

# ---- dev: Vite dev server with HMR, source is bind-mounted at runtime ----
FROM base AS dev
COPY web/. .
EXPOSE 3000
CMD ["npm", "run", "dev"]

# ---- build: compile + bundle the production React app ----
FROM node:20-alpine AS build
WORKDIR /build
COPY shared/ shared/
COPY web/package*.json web/
RUN npm ci --prefix web
COPY web/ web/
WORKDIR /build/web
# Empty (not unset) on purpose: bakes import.meta.env.VITE_API_URL as "" so
# apiClient.ts's `?? 'http://localhost:4000'` fallback does NOT trigger and
# all API calls become relative paths, resolved through whatever host/port
# nginx serves this build on. The frontend never needs to know the API
# container's address.
ENV VITE_API_URL=
RUN npm run build

# ---- prod: static files served by nginx, reverse-proxying /api and /health ----
FROM nginx:1-alpine AS prod
COPY --from=build /build/web/dist /usr/share/nginx/html
COPY web/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=5 \
  CMD wget -qO- http://127.0.0.1/ || exit 1
