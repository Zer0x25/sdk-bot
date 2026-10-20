FROM node:22-bookworm-slim AS panel-build

WORKDIR /app
COPY gateway/package.json /app/gateway/package.json
COPY gateway/package-lock.json /app/gateway/package-lock.json
COPY gateway/.npmrc /app/gateway/.npmrc
COPY packages/contracts /app/packages/contracts
WORKDIR /app/gateway
RUN --mount=type=secret,id=proxy-ca,target=/tmp/proxy-ca,required=false \
    if [ -s /tmp/proxy-ca ]; then NODE_EXTRA_CA_CERTS=/tmp/proxy-ca npm ci; else npm ci; fi
COPY gateway/panel/web /app/gateway/panel/web
RUN npm run panel:build
RUN npm prune --omit=dev

FROM node:22-bookworm-slim AS runtime

WORKDIR /app
COPY gateway gateway
COPY --from=panel-build /app/gateway/node_modules /app/gateway/node_modules
COPY --from=panel-build /app/gateway/panel/web/dist /app/gateway/panel/web/dist
COPY .env.tuning .env.tuning
RUN mkdir -p /app/brain

WORKDIR /app/gateway
CMD ["node", "index.js"]
