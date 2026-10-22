FROM node:22-bookworm-slim AS panel-build

WORKDIR /app
COPY apps/gateway/package.json /app/apps/gateway/package.json
COPY apps/gateway/package-lock.json /app/apps/gateway/package-lock.json
COPY apps/gateway/.npmrc /app/apps/gateway/.npmrc
COPY apps/panel/package.json /app/apps/panel/package.json
COPY apps/panel/package-lock.json /app/apps/panel/package-lock.json
COPY apps/panel/.npmrc /app/apps/panel/.npmrc
COPY packages/contracts /app/packages/contracts
WORKDIR /app/apps/gateway
RUN --mount=type=secret,id=proxy-ca,target=/tmp/proxy-ca,required=false \
    if [ -s /tmp/proxy-ca ]; then NODE_EXTRA_CA_CERTS=/tmp/proxy-ca npm ci; else npm ci; fi
WORKDIR /app/apps/panel
RUN --mount=type=secret,id=proxy-ca,target=/tmp/proxy-ca,required=false \
    if [ -s /tmp/proxy-ca ]; then NODE_EXTRA_CA_CERTS=/tmp/proxy-ca npm ci; else npm ci; fi
COPY apps/panel /app/apps/panel
RUN npm run build
RUN npm prune --omit=dev
WORKDIR /app/apps/gateway
RUN npm prune --omit=dev

FROM node:22-bookworm-slim AS runtime

WORKDIR /app
COPY apps/gateway apps/gateway
COPY apps/panel apps/panel
COPY --from=panel-build /app/apps/gateway/node_modules /app/apps/gateway/node_modules
COPY --from=panel-build /app/apps/panel/node_modules /app/apps/panel/node_modules
COPY --from=panel-build /app/apps/panel/web/dist /app/apps/panel/web/dist
COPY .env.tuning .env.tuning
RUN mkdir -p /app/brain /app/gateway

WORKDIR /app/apps/gateway
CMD ["node", "index.js"]
