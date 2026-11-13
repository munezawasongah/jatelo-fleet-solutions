# Build from the repository root:  docker build -f apps/web/Dockerfile -t jfs-web .
# Serves the PWA and proxies /api and /socket.io to the API so cookies stay same-origin.
FROM node:22-alpine AS build
RUN corepack enable
WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json tsconfig.base.json ./
COPY apps/web ./apps/web
RUN pnpm install --frozen-lockfile --filter @jfs/web && pnpm --filter @jfs/web build

FROM nginx:1.27-alpine
ENV API_UPSTREAM=http://api:4000 PORT=8080
COPY apps/web/nginx.conf.template /etc/nginx/templates/default.conf.template
COPY --from=build /repo/apps/web/dist /usr/share/nginx/html
EXPOSE 8080
