# syntax=docker/dockerfile:1
#
# agent-runtime image (ADR 0004): generic, non-root, baked-in deps; state (creds,
# plugins) comes from the PVC at runtime. Lifecycle = runtime version.

# ---- builder: compile the supervisor + build node-pty natively ----
FROM node:20-bookworm AS builder
WORKDIR /app
COPY package.json tsconfig.json ./
RUN npm install --no-audit --no-fund
COPY src ./src
RUN npm run build && npm prune --omit=dev   # tsc -> dist/, then drop devDeps (keep node-pty)

# ---- runtime ----
FROM node:20-bookworm-slim
ARG CLAUDE_VERSION=2.1.197

# system deps: tini (PID 1 / zombie reaper), git/curl/ca-certs (the agent needs them)
RUN apt-get update && apt-get install -y --no-install-recommends \
      tini git curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# use the image's existing non-root `node` user (uid 1000 — skip-permissions needs non-root,
# ADR 0003/0004); give it /app
RUN mkdir -p /app && chown node:node /app
USER node
ENV HOME=/home/node
WORKDIR /app

# the runtime: Claude Code via the NATIVE installer (standalone binary), pinned (image
# lifecycle = runtime version, ADR 0004). Lands in ~/.local — NOT ~/.claude — so the PVC
# mount on ~/.claude at runtime never hides it.
RUN curl -fsSL https://claude.ai/install.sh | bash -s -- "${CLAUDE_VERSION}"
ENV PATH=/home/node/.local/bin:$PATH

# supervisor + its prod deps (incl the natively-built node-pty) from the builder
COPY --from=builder --chown=node:node /app/node_modules ./node_modules
COPY --from=builder --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json ./

# baked onboarding/trust seed (ADR 0004): zero startup prompts. Written AFTER the installer
# (which drops a default ~/.claude.json) so this one wins. Creds + the channel plugin are NOT
# baked — they arrive on the PVC at runtime (ADR 0006 / agora ADR 0003).
COPY --chown=node:node image/claude.json.seed /home/node/.claude.json

# the runtime working dir (the channel's .mcp.json / plugin is mounted/installed here at deploy)
RUN mkdir -p /home/node/work
ENV RUNTIME_CWD=/home/node/work PORT=8080 HOST=0.0.0.0
EXPOSE 8080

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/index.js"]
