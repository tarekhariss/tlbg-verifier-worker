FROM node:20-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY worker.mjs ./
USER node
CMD ["node", "worker.mjs"]
