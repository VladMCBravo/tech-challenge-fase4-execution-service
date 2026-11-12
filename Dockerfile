# Stage 1 — build
FROM node:22-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci --ignore-scripts
COPY . .
RUN npm run build

# Stage 2 — runtime
FROM node:22-alpine AS runner
WORKDIR /app
COPY package*.json ./
RUN npm ci --ignore-scripts --omit=dev
COPY --from=builder /app/dist ./dist
# Logs estruturados em JSON (pino) e sem dependências de desenvolvimento no runtime
ENV NODE_ENV=production
USER node
EXPOSE 3002
CMD ["/bin/sh", "-c", "[ -f dist/src/main.js ] && node dist/src/main.js || node dist/main.js"]
