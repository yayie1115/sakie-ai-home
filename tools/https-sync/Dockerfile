FROM node:24-alpine
WORKDIR /app
COPY package.json package-lock.json ./
COPY backend/package.json backend/package.json
COPY frontend/package.json frontend/package.json
COPY local-agent/package.json local-agent/package.json
COPY packages/contracts packages/contracts
RUN npm ci --omit=dev --workspace backend --ignore-scripts && npm cache clean --force
COPY backend/dist backend/dist
COPY tools/https-sync/cloud.mjs tools/https-sync/cloud.mjs
USER 1000:1000
CMD ["node", "tools/https-sync/cloud.mjs"]
