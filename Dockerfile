FROM node:22.22.2-alpine3.22

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000
ENV DATA_DIR=/app/data/projects
ENV PUBLIC_DIR=/app/public
ENV TEX_BIN_PATH=
ENV TEX_PATH_LOCKED=false
ENV COMPILE_TIMEOUT_MS=30000

COPY package*.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY public ./public

RUN mkdir -p /app/data/projects && chown -R node:node /app/data

USER node

EXPOSE 3000

CMD ["npm", "start"]
