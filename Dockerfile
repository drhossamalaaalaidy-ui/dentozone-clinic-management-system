# Build one image, then run that same image on any OCI-compatible host.
FROM node:24-bookworm-slim AS builder
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@10.26.1 --activate
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm run typecheck \
    && BASE_PATH=/ pnpm --filter @workspace/dentozone run build \
    && pnpm --filter @workspace/api-server run build

FROM node:24-bookworm-slim
ENV NODE_ENV=production PORT=8080 SERVE_STATIC=true AUTH_PROVIDER=oidc STORAGE_PROVIDER=s3
WORKDIR /app
COPY --from=builder --chown=node:node /app /app
USER node
EXPOSE 8080
CMD ["node", "--enable-source-maps", "artifacts/api-server/dist/index.mjs"]