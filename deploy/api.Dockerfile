FROM node:24-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app/server
COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --chown=node:node server/src ./src
COPY --chown=node:node src/domain /app/src/domain
COPY --chown=node:node db/migrations /app/db/migrations
RUN mkdir -p /app/uploads && chown node:node /app/uploads && chmod 700 /app/uploads
USER node
EXPOSE 8080
CMD ["node", "src/index.js"]
