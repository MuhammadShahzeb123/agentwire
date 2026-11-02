FROM node:22-alpine
WORKDIR /app
COPY package.json ./
COPY src ./src
ENV AGENTWIRE_DB=/data/agentwire.db PORT=7777
VOLUME /data
EXPOSE 7777
CMD ["node", "src/cli.js", "serve"]
