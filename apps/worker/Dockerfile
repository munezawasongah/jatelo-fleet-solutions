# Build from the repository root:  docker build -f apps/worker/Dockerfile -t jfs-worker .
FROM node:22-alpine AS build
RUN corepack enable
WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json tsconfig.base.json ./
COPY packages ./packages
COPY apps/worker ./apps/worker
RUN pnpm install --frozen-lockfile --filter "@jfs/worker..." \
 && pnpm --filter "@jfs/worker..." build \
 && rm -rf node_modules apps/*/node_modules packages/*/node_modules \
 && pnpm install --frozen-lockfile --prod --filter "@jfs/worker..." \
 && rm -rf packages/*/src apps/worker/src

FROM node:22-alpine
RUN apk add --no-cache tini
ENV NODE_ENV=production
WORKDIR /repo
COPY --from=build --chown=node:node /repo /repo
WORKDIR /repo/apps/worker
USER node

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/main.js"]
