# Build from the repository root:  docker build -f apps/ingest/Dockerfile -t jfs-ingest .
FROM node:22-alpine AS build
RUN corepack enable
WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json tsconfig.base.json ./
COPY packages ./packages
COPY apps/ingest ./apps/ingest
RUN pnpm install --frozen-lockfile --filter "@jfs/ingest..." \
 && pnpm --filter "@jfs/ingest..." build \
 && rm -rf node_modules apps/*/node_modules packages/*/node_modules \
 && pnpm install --frozen-lockfile --prod --filter "@jfs/ingest..." \
 && rm -rf packages/*/src apps/ingest/src

FROM node:22-alpine
RUN apk add --no-cache tini
ENV NODE_ENV=production
WORKDIR /repo
COPY --from=build --chown=node:node /repo /repo
WORKDIR /repo/apps/ingest
USER node
EXPOSE 5080 5027 5023 5004
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/main.js"]
