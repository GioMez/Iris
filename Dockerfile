FROM node:24.18.0-alpine3.23

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000
ENV DATA_DIR=/app/data/projects
ENV PUBLIC_DIR=/app/public
ENV TEX_BIN_PATH=
ENV TEX_PATH_LOCKED=false
ENV LILYPOND_BIN_PATH=
ENV LILYPOND_PATH_LOCKED=false
ENV COMPILE_TIMEOUT_MS=30000

COPY package*.json ./
RUN npm ci --omit=dev --omit=optional

COPY src ./src
COPY db/migrations ./db/migrations
COPY public ./public

RUN mkdir -p /app/data/projects && chown -R node:node /app/data

USER node

EXPOSE 3000

CMD ["npm", "start"]
