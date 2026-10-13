.PHONY: up down dev

PORT ?= 8787

up: ## build, then run the server in the foreground (Ctrl-C or `make down` stops it)
	pnpm install && (cd engine && uv sync)
	pnpm --filter @calque/slide-ui build && pnpm --filter @calque/web build
	PORT=$(PORT) node --env-file-if-exists=.env apps/server/src/main.ts

down:
	-lsof -ti :$(PORT) | xargs kill

dev: ## server + Vite hot reload (web on :5173)
	@trap 'kill 0' INT TERM; node apps/server/src/main.ts & pnpm --filter @calque/web dev & wait
