FROM node:22-alpine

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000
ENV DATA_DIR=/app/data/projects
ENV PUBLIC_DIR=/app/public

COPY package*.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY public ./public

RUN mkdir -p /app/data/projects

EXPOSE 3000

CMD ["npm", "start"]
