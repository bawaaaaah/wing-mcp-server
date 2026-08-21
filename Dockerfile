# ---- builder ----
FROM node:24-alpine AS builder
WORKDIR /app
COPY package*.json ./
COPY web/package*.json web/
RUN npm ci
COPY . .
RUN npm run build

# ---- runtime ----
FROM node:24-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/web/dist ./web/dist
RUN mkdir -p /app/data && chown -R node:node /app
VOLUME ["/app/data"]
EXPOSE 8787
USER node
CMD ["node", "dist/index.js"]
