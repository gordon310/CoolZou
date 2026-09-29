FROM node:24-bookworm-slim
WORKDIR /app
COPY package.json server.mjs ./
ENV NODE_ENV=production PORT=80
EXPOSE 80
CMD ["node", "server.mjs"]
