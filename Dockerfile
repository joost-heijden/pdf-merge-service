FROM node:24-bookworm-slim

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000

WORKDIR /app

RUN npm install --global pnpm@11.25.0
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --prod --frozen-lockfile
COPY --chown=node:node src ./src

USER node
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node --input-type=module -e "const r = await fetch('http://127.0.0.1:3000/healthz', {signal: AbortSignal.timeout(3000)}); process.exit(r.ok ? 0 : 1);"

CMD ["node", "src/server.js"]
