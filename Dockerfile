FROM node:22-alpine

WORKDIR /app

COPY package.json ./
COPY server.js ./
COPY lib ./lib
COPY scripts ./scripts
COPY run.sh ./
COPY tokens.example.txt ./

ENV PORT=8787 HOST=0.0.0.0 DEFAULT_MODEL=deepseek-chat
EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD wget -qO- "http://127.0.0.1:${PORT}/health" >/dev/null || exit 1

CMD ["node", "server.js"]
