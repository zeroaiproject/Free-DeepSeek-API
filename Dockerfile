FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production PORT=8787 HOST=0.0.0.0 DEFAULT_MODEL=deepseek-chat

# No npm install: zero runtime dependencies.
COPY package.json LICENSE ./
COPY server.js run.sh ./
COPY lib ./lib
COPY scripts ./scripts
COPY tokens.example.txt .env.example ./

RUN chmod +x run.sh scripts/*.js || true

EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD wget -qO- "http://127.0.0.1:${PORT}/health" >/dev/null || exit 1

USER node
CMD ["node", "server.js"]
