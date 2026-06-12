FROM node:22-alpine
WORKDIR /app
COPY package.json ./
COPY server.mjs ./
ENV PORT=8787
EXPOSE 8787
CMD ["node", "server.mjs"]
