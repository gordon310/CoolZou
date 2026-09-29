FROM node:24-bookworm-slim

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY server ./server
COPY web ./web
RUN mkdir -p /app/var/files && chown -R node:node /app

ENV NODE_ENV=production HOST=0.0.0.0 PORT=4317
USER node
EXPOSE 4317
VOLUME ["/app/var"]
CMD ["node", "server/main.mjs"]
