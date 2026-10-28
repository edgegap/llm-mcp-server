# Self-hosted Edgegap MCP server over Streamable HTTP (src/http.ts).
#
#   docker build -t edgegap-mcp .
#   docker run --rm -p 8080:8080 edgegap-mcp
#
# Clients send their own Edgegap token as an Authorization header on every
# request. The image holds no credential; do not add one.
#
# Built for linux/amd64 and linux/arm64. The build output and the runtime
# dependencies are plain JavaScript (no native addons or install scripts), so
# both are produced once on the builder's own platform and copied into each
# target image: the target stage runs nothing, and needs no emulation.

FROM --platform=$BUILDPLATFORM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
COPY scripts/chmod-bin.mjs ./scripts/chmod-bin.mjs
RUN npm run build

FROM --platform=$BUILDPLATFORM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund --ignore-scripts && npm cache clean --force

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=8080 HOST=0.0.0.0
COPY package.json package-lock.json ./
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "dist/http.js"]
