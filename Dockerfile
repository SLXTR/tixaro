FROM node:22-alpine

ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY public ./public
COPY src ./src
COPY views ./views
COPY docker-entrypoint.sh ./docker-entrypoint.sh

RUN mkdir -p /app/data && chown node:node /app/data && chmod 755 /app/docker-entrypoint.sh

USER node
EXPOSE 3000
ENTRYPOINT ["/app/docker-entrypoint.sh"]
CMD ["node", "src/server.js"]
