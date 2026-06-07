# syntax=docker/dockerfile:1

# --- build stage ---------------------------------------------------------------
# Base image pinned by digest (lesson H-4): node:22-bookworm-slim.
FROM node@sha256:7af03b14a13c8cdd38e45058fd957bf00a72bbe17feac43b1c15a689c029c732 AS build
WORKDIR /app

# Install with the lockfile and DO NOT run lifecycle scripts (lesson C-1: no postinstall,
# exact versions from package-lock.json). The ripgrep binary ships as a per-platform
# optional dependency (@vscode/ripgrep-linux-x64) — no build-time download, no script.
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

COPY tsconfig.json ./
COPY src ./src
RUN npx tsc -p tsconfig.json

# Prune dev dependencies for the runtime copy.
RUN npm prune --omit=dev --ignore-scripts

# --- runtime stage -------------------------------------------------------------
FROM node@sha256:7af03b14a13c8cdd38e45058fd957bf00a72bbe17feac43b1c15a689c029c732 AS runtime
ENV NODE_ENV=production
WORKDIR /app

# Copy only what the runtime needs.
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./

# Writable log dir owned by the unprivileged user. A fresh named volume mounted here
# inherits this ownership on first init, so logging under USER node does not hit EACCES.
RUN mkdir -p /var/log/vault-mcp && chown node:node /var/log/vault-mcp

# Non-root (lesson H-4). The base image ships an unprivileged `node` user.
USER node

# Loopback inside the container network namespace; Caddy is the only ingress.
ENV BIND_HOST=0.0.0.0
EXPOSE 8787

# No shell form (no implicit /bin/sh -c), so there is no shell to inject into.
ENTRYPOINT ["node", "dist/index.js"]
