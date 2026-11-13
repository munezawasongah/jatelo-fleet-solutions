# Build from the repository root:  docker build -f apps/api/Dockerfile -t jfs-api .
FROM node:22-alpine AS build
RUN corepack enable
WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json tsconfig.base.json ./
COPY packages ./packages
COPY apps/api ./apps/api
RUN pnpm install --frozen-lockfile --filter "@jfs/api..." \
 && pnpm --filter "@jfs/api..." build \
 && rm -rf node_modules apps/*/node_modules packages/*/node_modules \
 && pnpm install --frozen-lockfile --prod --filter "@jfs/api..." \
 && rm -rf packages/*/src apps/api/src

FROM node:22-alpine
RUN apk add --no-cache tini
ENV NODE_ENV=production
WORKDIR /repo
COPY --from=build --chown=node:node /repo /repo
WORKDIR /repo/apps/api
USER node
EXPOSE 4000
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/server.js"]
