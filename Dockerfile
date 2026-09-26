# syntax=docker/dockerfile:1
# ---- dependencies (production only) ----
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

# ---- runtime ----
FROM node:22-alpine
ENV NODE_ENV=production \
    PORT=3000
WORKDIR /app
RUN addgroup -S dunia && adduser -S dunia -G dunia
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY server ./server
COPY shared ./shared
COPY public ./public
COPY data/blocked-words.txt ./data/blocked-words.txt
RUN chown -R dunia:dunia /app/data
USER dunia
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s \
  CMD wget -qO- http://127.0.0.1:3000/healthz >/dev/null || exit 1
CMD ["node", "server/index.js"]
