FROM node:22-bookworm-slim

WORKDIR /app

COPY gateway/package.json /app/gateway/package.json
COPY gateway/package-lock.json /app/gateway/package-lock.json
COPY gateway/.npmrc /app/gateway/.npmrc
COPY packages/contracts /app/packages/contracts
WORKDIR /app/gateway
RUN npm ci --omit=dev

WORKDIR /app
COPY gateway gateway
COPY .env.tuning .env.tuning
RUN mkdir -p /app/brain

WORKDIR /app/gateway
CMD ["node", "index.js"]
