# Stage 1: build the React SPA (dev deps + Vite only live here).
FROM node:22-alpine AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY web ./web
COPY vite.config.js ./
RUN npm run build

# Stage 2: lean runtime — express + multer only, no dev deps.
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production DATA_DIR=/app/data

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src ./src
COPY --from=build /app/dist ./dist

RUN mkdir -p /app/data && chown -R node:node /app/data

USER node

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget --spider -q http://127.0.0.1:3000/api/health || exit 1

CMD ["node", "src/server.js"]
