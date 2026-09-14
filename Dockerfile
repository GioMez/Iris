FROM docker.io/library/node:24.18.0-alpine3.23

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000
ENV DATA_DIR=/app/data
ENV PUBLIC_DIR=/app/public
ENV TEMPLATE_DIR=/app/data/templates
COPY package.json package-lock.json .npmrc ./
RUN npm ci --omit=dev --omit=optional && npm cache clean --force

COPY src ./src
COPY db/schema.sql ./db/schema.sql
COPY public ./public
COPY LICENSE THIRD_PARTY_NOTICES.md ./

RUN mkdir -p /app/data/projects && chown -R node:node /app/data

USER node

EXPOSE 3000

CMD ["node", "src/server.js"]
