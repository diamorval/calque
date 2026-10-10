# syntax=docker/dockerfile:1
# The Calque server: MCP (/mcp), REST (/api), the web app (/) and deck previews (/decks/:id),
# with the Python engine it spawns per call and LibreOffice + pdftoppm for renders.
# One image, not three (web, agent, engine): the web app is static files this server serves, the
# agent runs in the server process, and the engine is a subprocess on stdin/stdout (engine.ts).

FROM node:24-trixie-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /app

# The web app and the deck UI bundle: only their dist/ reach the runtime image.
FROM base AS build
COPY . .
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile
RUN pnpm --filter @calque/slide-ui build && pnpm --filter @calque/web build

FROM base
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 libreoffice-impress poppler-utils fonts-liberation fonts-dejavu-core \
  && apt-get clean && rm -rf /var/lib/apt/lists/*
COPY --from=ghcr.io/astral-sh/uv:0.11.32 /uv /usr/local/bin/uv

# Engine: locked dependencies on the system Python, no dev tools.
ENV UV_PYTHON=python3 UV_PYTHON_DOWNLOADS=never UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy
COPY engine/pyproject.toml engine/uv.lock engine/
RUN --mount=type=cache,target=/root/.cache/uv uv sync --project engine --locked --no-dev --no-install-project
COPY engine/src engine/src
RUN --mount=type=cache,target=/root/.cache/uv uv sync --project engine --locked --no-dev

# Server: production dependencies only; Node runs its TypeScript as is.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/server/package.json apps/server/
COPY apps/agent/package.json apps/agent/
COPY apps/web/package.json apps/web/
COPY packages/deckspec/package.json packages/deckspec/
COPY packages/design/package.json packages/design/
COPY packages/llm/package.json packages/llm/
COPY packages/slide-ui/package.json packages/slide-ui/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile --prod --filter @calque/server...
COPY apps/server apps/server
COPY apps/agent apps/agent
COPY packages packages
COPY core core
COPY packs packs
COPY --from=build /app/apps/web/dist apps/web/dist
COPY --from=build /app/packages/slide-ui/dist packages/slide-ui/dist

RUN mkdir /data && chown node:node /data
VOLUME /data
ENV NODE_ENV=production PORT=8787 CALQUE_DATA=/data CALQUE_PACKS=/app/packs \
  CALQUE_ENGINE="/app/engine/.venv/bin/python -m calque_engine call"
USER node
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s \
  CMD node -e "fetch('http://127.0.0.1:' + process.env.PORT + '/api/tools').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"
CMD ["node", "apps/server/src/main.ts"]
